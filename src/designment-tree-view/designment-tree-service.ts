import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeDataProvider, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import { GranularityNode } from '../granularity-view/granularity-record'

// Interfaces for modules json persistence.
interface ModuleEntry {
    name: string
    dependencies: string[]
    description: string
    path: string
}

function readModuleEntriesFromJsonFile(jsonFilePath: string): ModuleEntry[] {
    if (!fs.existsSync(jsonFilePath)) {
        throw new Error(`Modules JSON file not found at path: ${jsonFilePath}`)
    }

    const fileContent = fs.readFileSync(jsonFilePath, 'utf8')
    try {
        const moduleEntries: ModuleEntry[] = JSON.parse(fileContent)
        return moduleEntries
    } catch (error) {
        throw new Error(`Error parsing modules JSON file: ${error}`)
    }
}

// Helper function to get a module's full name, e.g. "parent.module"
function getModuleFullName(node: DirectoryNode): string {
    let moduleFullName = node.label
    let iter = node.parent
    while (iter && iter.type === NodeType.Module) {
        moduleFullName = iter.label + '.' + moduleFullName
        iter = iter.parent
    }
    
    return moduleFullName
}


// Below are services for designment tree operations.

export async function createModule(
    parent: DirectoryNode,
    label: string,
    content?: string
) {
    const absolutePath = path.join(parent.absolutePath, label)
    if (parent.children.find(child => child.absolutePath === absolutePath)) {
        vscode.window.showErrorMessage(`当前父模块下已存在同名子模块 ${label}，请更换模块名称。`)
        return
    }

    const filePath = path.join(absolutePath, 'content.txt')
    // When adding a new leaf module, always initialize a json file with granularity zero.
    const jsonPath = path.join(absolutePath, 'node.json')
    const designmentPath = path.join(absolutePath, 'designment_info.txt')

    try {
        fs.mkdirSync(absolutePath, { recursive: true })
        fs.writeFileSync(filePath, content ? content : 'Empty content.', 'utf8')

        const firstGranulairty: GranularityNode = {
            index: 1,
            description: '模块规约',
            filePath: designmentPath,
            nodeType: 'pseudo',
            isActive: false
        }

        fs.writeFileSync(jsonPath, JSON.stringify([firstGranulairty], null, 4), 'utf8')

        // For now the parent is no longer a leaf, so delete its json file.
        if (parent.children.length === 0) {
            const parentJsonPath = path.join(parent.absolutePath, 'node.json')
            if (fs.existsSync(parentJsonPath)) {
                fs.unlinkSync(parentJsonPath)
            }
        }
    } catch (error) {
        vscode.window.showErrorMessage(`创建模块失败: ${error}`)
        throw error
    }

    const newModule = new DirectoryNode(label, absolutePath, NodeType.Module, parent, filePath, [], parent.banned)
    parent.children.push(newModule)
    const dataProvider = DesignmentTreeDataProvider.getInstance()
    dataProvider.refresh(parent)

}


export async function createProject(label: string) {

    // 确保项目结构存在（codes 和 pseudocodes 文件夹）
    const structureReady = await settings.ensureProjectStructure();
    if (!structureReady) {
        return; // 用户取消了创建
    }

    const dataProvider = DesignmentTreeDataProvider.getInstance()
    if (dataProvider.localNodeTree.find(child => child.label === label)) {
        vscode.window.showErrorMessage(`已存在同名项目 ${label}，请更换项目名称。`)
        return
    }

    const absolutePath = path.join(settings.getAiPath(), label)
    const filePath = path.join(absolutePath, 'content.txt')

    try {
        fs.mkdirSync(absolutePath, { recursive: true })
        fs.writeFileSync(filePath, 'Empty content.', 'utf8')

    } catch (error) {
        vscode.window.showErrorMessage(`创建项目失败: ${error}`)
        throw error
    }

    const newProj = new DirectoryNode(label, absolutePath, NodeType.Project, undefined, filePath)
    const reqModule = new FileNode('Project Requirement', filePath, NodeType.Requirement, newProj)
    newProj.children.push(reqModule)

    dataProvider.localNodeTree.push(newProj)
    dataProvider.refresh(undefined)
}


export async function deleteProjectNode(node: DirectoryNode) {

    if (node.type !== NodeType.Project) {
        throw new Error('Function deleteProjectNode only accepts project nodes.')
    }

    // Deleting corresponding folder in fs.
    fs.rmSync(node.absolutePath, { recursive: true, force: true })

    const designmentTreeDataProvider = DesignmentTreeDataProvider.getInstance()
    const parentChildren = designmentTreeDataProvider.localNodeTree
    const index = parentChildren.indexOf(node)
    parentChildren.splice(index, 1)
    designmentTreeDataProvider.refresh(node.parent)
}


export async function deleteModuleNode(node: DirectoryNode) {
    if (node.type !== NodeType.Module) {
        throw new Error('Function deleteModuleNode only accepts module nodes.')
    }

    // Deleting corresponding folder in fs.
    fs.rmSync(node.absolutePath, { recursive: true, force: true })

    // Deleting modules in modules.json and onGoingLeafModules.json files.
    let moduleFullName = getModuleFullName(node)

    let iter = node
    while (iter.parent) {
        iter = iter.parent
    }

    const projectPath = iter.absolutePath
    const modulesJsonPath = path.join(projectPath, 'modules.json')
    const ongoingLeafModulesJsonPath = path.join(projectPath, 'ongoing_leaf_modules.json')

    // Update modules.json
    let modulesEntries = readModuleEntriesFromJsonFile(modulesJsonPath)
    let ongoingLeafModulesEntries = readModuleEntriesFromJsonFile(ongoingLeafModulesJsonPath)

    modulesEntries = modulesEntries.filter(entry => !entry.name.startsWith(moduleFullName))
    ongoingLeafModulesEntries = ongoingLeafModulesEntries.filter(entry => !entry.name.startsWith(moduleFullName))

    // Remove the node from tree structure.
    const parent = node.parent

    if (!parent) {
        throw new Error('Module node has no parent.')
    }

    const parentFullName = getModuleFullName(parent)
    const parentChildren = parent.children
    const index = parentChildren.indexOf(node)
    parentChildren.splice(index, 1)

    // If the parent now has no children, it becomes a leaf again.
    if (parentChildren.length === 0) {
        const parentPath = parent.absolutePath
        const nodeJsonPath = path.join(parentPath, 'node.json')
        const designmentPath = path.join(parentPath, 'designment_info.txt')
        const firstGranulairty: GranularityNode = {
            index: 1,
            description: '模块规约',
            filePath: designmentPath,
            nodeType: 'pseudo',
            isActive: false
        }

        fs.writeFileSync(nodeJsonPath, JSON.stringify([firstGranulairty], null, 4), 'utf8')

        // Add parent to the ongoingLeafModules.json
        const parentModuleEntry = modulesEntries.find(entry => entry.name === parentFullName)

        if (!parentModuleEntry) {
            throw new Error('Unexpected error: parent module entry not found in modules.json.')
        }

        ongoingLeafModulesEntries.push(parentModuleEntry)
    }

    // Handle dependencies.
    modulesEntries.forEach(entry => {
        const newDependencies = entry.dependencies.filter(dep => !dep.startsWith(moduleFullName))
        if (newDependencies.length < entry.dependencies.length && parentChildren.length === 0) {
            newDependencies.push(parentFullName)
        }
        entry.dependencies = newDependencies
    })

    ongoingLeafModulesEntries.forEach(entry => {
        const newDependencies = entry.dependencies.filter(dep => !dep.startsWith(moduleFullName))
        if (newDependencies.length < entry.dependencies.length && parentChildren.length === 0) {
            newDependencies.push(parentFullName)
        }
        entry.dependencies = newDependencies
    })

    fs.writeFileSync(modulesJsonPath, JSON.stringify(modulesEntries, null, 2), 'utf8')
    fs.writeFileSync(ongoingLeafModulesJsonPath, JSON.stringify(ongoingLeafModulesEntries, null, 2), 'utf8')

    DesignmentTreeDataProvider.getInstance().refresh(parent)
}
