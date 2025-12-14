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
    childrenCount: number
}

const persistentFilePath: string = path.join(settings.getAiPath(), 'persisted_tree.json')


export function buildTreeFromSerializedForm(): DesignmentTreeNode[] {
    if (!fs.existsSync(persistentFilePath)) {
        return []
    }

    const treeSequences: persistenceTreeNode[][] = JSON.parse(fs.readFileSync(persistentFilePath, 'utf-8'))
    return treeSequences.map(treeSequence => parseProjectTree(treeSequence, undefined))
}


// Recursive function to parse a project tree.
function parseProjectTree(treeSequence: persistenceTreeNode[], parent: DirectoryNode | undefined): DesignmentTreeNode {
    if (treeSequence.length === 0) {
        throw Error('Unexpected error: encountered empty tree sequence while building project tree')
    }

    const currentNode = treeSequence.shift()
    assert(currentNode, 'Unexpected error: tree sequence is unexpectedly empty.')

    const nodeType = NodeType[currentNode.type as keyof typeof NodeType]
    if (nodeType === NodeType.Project || nodeType === NodeType.Module) {
        const newNode = new DirectoryNode(currentNode.label, currentNode.absolutePath, nodeType, parent)
        for (let i = 0; i < currentNode.childrenCount; i++) {
            newNode.children.push(parseProjectTree(treeSequence, newNode))
        }
        return newNode
    } else if (nodeType === NodeType.Requirement || nodeType === NodeType.DataStructure) {
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
            serializeProject(project, projectObjectSequence)
            projects.push(projectObjectSequence)
        } else {
            throw Error('Unexpected error: root node of a designment tree is not a project directory node')
        }
    })    

    fs.writeFileSync(persistentFilePath, JSON.stringify(projects, null, 2))
}

// Recursive function for serializing a project tree.
function serializeProject(root: DesignmentTreeNode, sequence: persistenceTreeNode[]): void {
    sequence.push(root.getObject())
    if (root instanceof DirectoryNode) {
        root.children.forEach(child => {
            serializeProject(child, sequence)
        })
    }
}
