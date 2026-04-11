import assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeNode, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'

export interface persistenceTreeNode {
    label: string
    absolutePath: string
    type: string
    // When parsing the object tree, we only need to know if it has children or not.
    childrenCount: number,
    contentFilePath?: string
}

const persistentFilePath: string = path.join(settings.getAiPath(), 'persisted_tree.json')


export function buildTreeFromSerializedForm(): DesignmentTreeNode[] {
    const treeSequences: persistenceTreeNode[][] = (() => {
        if (!fs.existsSync(persistentFilePath)) {
            return []
        }

        try {
            return JSON.parse(fs.readFileSync(persistentFilePath, 'utf-8'))
        } catch {
            return []
        }
    })()

    const serializedTrees = treeSequences
        .map(treeSequence => {
            try {
                return parseProjectTree([...treeSequence], undefined)
            } catch {
                return undefined
            }
        })
        .filter((node): node is DesignmentTreeNode => !!node)

    return reconcileProjectsFromFilesystem(serializedTrees)
}


function reconcileProjectsFromFilesystem(nodes: DesignmentTreeNode[]): DesignmentTreeNode[] {
    const aiPath = settings.getAiPath()
    if (!fs.existsSync(aiPath)) {
        return nodes
    }

    const result = [...nodes]
    const existingProjectPaths = new Set(
        result
            .filter(node => node instanceof DirectoryNode && node.type === NodeType.Project)
            .map(node => path.resolve(node.absolutePath))
    )

    const projectDirs = fs.readdirSync(aiPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => path.join(aiPath, dirent.name))

    projectDirs.forEach(projectPath => {
        const normalizedProjectPath = path.resolve(projectPath)
        if (existingProjectPaths.has(normalizedProjectPath)) {
            return
        }

        const projectName = path.basename(projectPath)
        const requirementPath = path.join(projectPath, 'content.txt')
        const dsPath = path.join(projectPath, 'common_data_structures.json')
        const rootPath = path.join(projectPath, 'Root')
        const rootContentPath = path.join(rootPath, 'content.txt')

        const hasRequirement = fs.existsSync(requirementPath)
        const hasDs = fs.existsSync(dsPath)
        const hasRoot = fs.existsSync(rootPath) && fs.existsSync(rootContentPath)

        // Not a valid project directory for design tree.
        if (!hasRequirement && !hasDs && !hasRoot) {
            return
        }

        const projectNode = new DirectoryNode(projectName, projectPath, NodeType.Project, undefined, hasRequirement ? requirementPath : undefined)

        if (hasDs) {
            projectNode.children.push(
                new DirectoryNode('Common Data Structures', dsPath, NodeType.DataStructure, projectNode, dsPath)
            )
        }

        if (hasRequirement) {
            projectNode.children.push(
                new FileNode('Project Requirement', requirementPath, NodeType.Requirement, projectNode)
            )
        }

        if (hasRoot) {
            projectNode.children.push(
                new DirectoryNode('Root', rootPath, NodeType.Module, projectNode, rootContentPath)
            )
        }

        result.push(projectNode)
    })

    return result
}


// Recursive function to parse a project tree.
function parseProjectTree(treeSequence: persistenceTreeNode[], parent: DirectoryNode | undefined): DesignmentTreeNode {
    if (treeSequence.length === 0) {
        throw Error('Unexpected error: encountered empty tree sequence while building project tree')
    }

    const currentNode = treeSequence.shift()
    assert(currentNode, 'Unexpected error: tree sequence is unexpectedly empty.')

    const nodeType = NodeType[currentNode.type as keyof typeof NodeType]
    if (nodeType === NodeType.Project || nodeType === NodeType.Module || nodeType === NodeType.DataStructure || nodeType === NodeType.NormalDirectory) {
        const newNode = new DirectoryNode(currentNode.label, currentNode.absolutePath, nodeType, parent, currentNode.contentFilePath)
        for (let i = 0; i < currentNode.childrenCount; i++) {
            newNode.children.push(parseProjectTree(treeSequence, newNode))
        }
        return newNode
    } else if (nodeType === NodeType.Requirement || nodeType === NodeType.NormalFile) {
        return new FileNode(currentNode.label, currentNode.absolutePath, nodeType, parent)
    } else {
        throw Error(`Unexpected node type encountered: ${currentNode.type}`)
    }
}


export async function persistTree(designmentTree: DesignmentTreeNode[]): Promise<void> {
    const projects: persistenceTreeNode[][] = []
    designmentTree.forEach(project => {
        if (project instanceof DirectoryNode && project.type === NodeType.Project) {
            const projectObjectSequence: persistenceTreeNode[] = []
            preOrderTraverseProject(project, projectObjectSequence)
            projects.push(projectObjectSequence)
        } else {
            throw Error('Unexpected error: root node of a designment tree is not a project directory node')
        }
    })    

    fs.writeFileSync(persistentFilePath, JSON.stringify(projects, null, 2))
}

// Recursive function for serializing a project tree.
function preOrderTraverseProject(root: DesignmentTreeNode, sequence: persistenceTreeNode[]): void {
    sequence.push(root.getObject())
    if (root instanceof DirectoryNode) {
        root.children.forEach(child => {
            preOrderTraverseProject(child, sequence)
        })
    }
}
