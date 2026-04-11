import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeDataProvider, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import { GranularityNode } from '../granularity-view/granularity-record'
import { get } from 'http'

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

function getProjectNode(node: DirectoryNode): DirectoryNode {
    let iter: DirectoryNode = node
    while (iter.parent) {
        iter = iter.parent
    }
    return iter
}

function toProjectRelativePath(projectPath: string, moduleAbsolutePath: string): string {
    const aiPath = settings.getAiPath()
    const projectName = path.basename(projectPath)
    const moduleSubPath = path.relative(projectPath, moduleAbsolutePath)
    return path.join(projectName, moduleSubPath)
}

function safeDeleteFile(filePath: string): void {
    if (!filePath) {
        return
    }

    if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true })
    }
}

function upsertModuleEntry(entries: ModuleEntry[], next: ModuleEntry): ModuleEntry[] {
    const index = entries.findIndex((item) => item.path === next.path)
    if (index >= 0) {
        entries[index] = next
    } else {
        entries.push(next)
    }
    return entries
}

function deleteIfExists(filePath: string): void {
    if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true })
    }
}

export async function resetFinalizedDesignState(projectPath: string): Promise<void> {
    const provider = DesignmentTreeDataProvider.getInstance()
    const projectNode = provider.getProjectNodeByAbsolutePath(projectPath)

    deleteIfExists(path.join(projectPath, 'leaf_modules.json'))
    deleteIfExists(path.join(projectPath, 'common_data_structures.json'))
    deleteIfExists(path.join(projectPath, 'confirmed_leaf_modules.json'))

    if (projectNode) {
        projectNode.children = projectNode.children.filter((child) => child.type !== NodeType.DataStructure)
        provider.refresh(projectNode)
    }
}

function resetSingleModuleHistory(moduleRootPath: string, activateFirst: boolean): void {
    const nodeJsonPath = path.join(moduleRootPath, 'node.json')
    if (!fs.existsSync(nodeJsonPath)) {
        return
    }

    const nodes = JSON.parse(fs.readFileSync(nodeJsonPath, 'utf8')) as GranularityNode[]
    if (nodes.length === 0) {
        return
    }

    const [firstNode, ...restNodes] = nodes
    restNodes.forEach((entry) => {
        safeDeleteFile(entry.filePath)
    })

    firstNode.isActive = activateFirst
    fs.writeFileSync(nodeJsonPath, JSON.stringify([firstNode], null, 4), 'utf8')
}

export async function discardRefinementFromModule(node: DirectoryNode): Promise<void> {
    const projectPath = getProjectNode(node).absolutePath
    const moduleRelativePath = toProjectRelativePath(projectPath, node.absolutePath)
    await discardRefinementFromModulePath(projectPath, moduleRelativePath, true)
}

export async function discardRefinementFromModulePath(
    projectPath: string,
    changedRelativePath: string,
    includeCurrentModule: boolean
): Promise<void> {
    const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
    if (!fs.existsSync(leafModulesPath)) {
        return
    }

    const aiPath = settings.getAiPath()
    const leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8')) as any[]
    if (leafModules.length === 0) {
        return
    }

    const startIndex = leafModules.findIndex((mod) => {
        const modulePath = mod.path || ''
        return modulePath === changedRelativePath || modulePath.startsWith(changedRelativePath + path.sep)
    })

    if (startIndex < 0) {
        return
    }

    leafModules.forEach((mod, index) => {
        if (mod.path) {
            const shouldReset = includeCurrentModule ? index >= startIndex : index > startIndex
            if (shouldReset) {
                const moduleRootPath = path.join(aiPath, mod.path)
                resetSingleModuleHistory(moduleRootPath, includeCurrentModule && index === startIndex)
            }
        }

        if (index < startIndex) {
            mod.status = 'completed'
        } else if (index === startIndex) {
            mod.status = 'ongoing'
        } else {
            mod.status = 'pending'
        }
    })

    fs.writeFileSync(leafModulesPath, JSON.stringify(leafModules, null, 4), 'utf8')
}

export async function updateLeafModuleDescription(node: DirectoryNode, description: string): Promise<void> {
    if (node.type !== NodeType.Module) {
        throw new Error('Only module description can be edited.')
    }

    const projectNode = getProjectNode(node)
    const projectPath = projectNode.absolutePath
    const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
    const modulesPath = path.join(projectPath, 'modules.json')
    const ongoingPath = path.join(projectPath, 'ongoing_leaf_modules.json')
    const relativePath = toProjectRelativePath(projectPath, node.absolutePath)
    const updateInFile = (targetPath: string): boolean => {
        if (!fs.existsSync(targetPath)) {
            return false
        }

        const arr = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as any[]
        const mod = arr.find((item) => item.path === relativePath)
        if (!mod) {
            return false
        }

        mod.description = description
        fs.writeFileSync(targetPath, JSON.stringify(arr, null, 4), 'utf8')
        return true
    }

    const updatedLeaf = updateInFile(leafModulesPath)
    const updatedModules = updateInFile(modulesPath)
    const updatedOngoing = updateInFile(ongoingPath)

    if (node.isLeaf() && !updatedLeaf && !updatedModules && !updatedOngoing) {
        throw new Error(`未在模块描述存储中找到路径：${relativePath}`)
    }

    // 同步更新模块目录下的 content.txt（模块节点的直接内容文件）
    const contentPath = path.join(node.absolutePath, 'content.txt')
    if (fs.existsSync(contentPath)) {
        try {
            const contentData = JSON.parse(fs.readFileSync(contentPath, 'utf8'))
            contentData.description = description
            fs.writeFileSync(contentPath, JSON.stringify(contentData, null, 4), 'utf8')
        } catch {
            // content.txt 不是 JSON 时忽略
        }
    }

    const designmentInfoPath = path.join(node.absolutePath, 'designment_info.txt')
    if (fs.existsSync(designmentInfoPath)) {
        try {
            const designInfo = JSON.parse(fs.readFileSync(designmentInfoPath, 'utf8'))
            designInfo.description = description
            fs.writeFileSync(designmentInfoPath, JSON.stringify(designInfo, null, 4), 'utf8')
        } catch {
            // Ignore malformed designment file in first version.
        }
    }
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

        const projectNode = getProjectNode(parent)
        const projectPath = projectNode.absolutePath
        const projectName = path.basename(projectPath)
        const moduleFullName = parent.type === NodeType.Module ? `${getModuleFullName(parent)}.${label}` : label

        let parsedContent: any = null
        if (content) {
            try {
                parsedContent = JSON.parse(content)
            } catch {
                parsedContent = null
            }
        }

        const description = parsedContent?.description || (content?.trim() || 'Empty content.')
        const moduleEntry: ModuleEntry = {
            name: moduleFullName,
            dependencies: Array.isArray(parsedContent?.dependencies) ? parsedContent.dependencies : [],
            description,
            path: path.join(projectName, moduleFullName.replace(/\./g, path.sep))
        }

        const payload = JSON.stringify(moduleEntry, null, 2)
        fs.writeFileSync(filePath, payload, 'utf8')
        fs.writeFileSync(designmentPath, payload, 'utf8')

        const firstGranulairty: GranularityNode = {
            index: 1,
            description: '模块规约',
            filePath: designmentPath,
            nodeType: 'pseudo',
            isActive: false
        }

        fs.writeFileSync(jsonPath, JSON.stringify([firstGranulairty], null, 4), 'utf8')

        // For now the parent is no longer a leaf, so delete its json file.
        if (parent.children.length === 0 && parent.type === NodeType.Module) {
            const parentJsonPath = path.join(parent.absolutePath, 'node.json')
            if (fs.existsSync(parentJsonPath)) {
                fs.unlinkSync(parentJsonPath)
            }
        }

        const modulesPath = path.join(projectPath, 'modules.json')
        const ongoingPath = path.join(projectPath, 'ongoing_leaf_modules.json')
        const readSafe = (targetPath: string): ModuleEntry[] => {
            if (!fs.existsSync(targetPath)) return []
            try {
                return JSON.parse(fs.readFileSync(targetPath, 'utf8'))
            } catch {
                return []
            }
        }

        let modules = readSafe(modulesPath)
        let ongoing = readSafe(ongoingPath)

        modules = upsertModuleEntry(modules, moduleEntry)
        ongoing = upsertModuleEntry(ongoing, moduleEntry)

        if (parent.type === NodeType.Module && parent.children.length === 0) {
            const parentPath = toProjectRelativePath(projectPath, parent.absolutePath)
            ongoing = ongoing.filter((entry) => entry.path !== parentPath)
        }

        fs.writeFileSync(modulesPath, JSON.stringify(modules, null, 2), 'utf8')
        fs.writeFileSync(ongoingPath, JSON.stringify(ongoing, null, 2), 'utf8')
    } catch (error) {
        vscode.window.showErrorMessage(`创建模块失败: ${error}`)
        throw error
    }

    const newModule = new DirectoryNode(label, absolutePath, NodeType.Module, parent, filePath, [], parent.banned)
    parent.children.push(newModule)
    const dataProvider = DesignmentTreeDataProvider.getInstance()
    dataProvider.refresh(parent)

}


export async function createProject(label: string, requirementText?: string): Promise<string | undefined> {

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
        fs.writeFileSync(filePath, requirementText && requirementText.trim().length > 0 ? requirementText : '请在此输入项目需求描述...', 'utf8')

    } catch (error) {
        vscode.window.showErrorMessage(`创建项目失败: ${error}`)
        throw error
    }

    const newProj = new DirectoryNode(label, absolutePath, NodeType.Project, undefined, filePath)
    const reqModule = new FileNode('Project Requirement', filePath, NodeType.Requirement, newProj)
    newProj.children.push(reqModule)

    const rootModuleName = 'Root'
    const rootModulePath = path.join(absolutePath, rootModuleName)
    const rootDescription = requirementText && requirementText.trim().length > 0
        ? (requirementText.trim().split(/\r?\n/).find((line) => line.trim().length > 0) || '项目根模块')
        : '项目根模块'

    const rootDescriptor = {
        name: rootModuleName,
        module_name: rootModuleName,
        dependencies: [],
        description: rootDescription,
        path: path.join(label, rootModuleName)
    }

    fs.mkdirSync(rootModulePath, { recursive: true })
    fs.writeFileSync(path.join(rootModulePath, 'content.txt'), JSON.stringify(rootDescriptor, null, 2), 'utf8')
    fs.writeFileSync(path.join(rootModulePath, 'designment_info.txt'), JSON.stringify(rootDescriptor, null, 2), 'utf8')

    const rootGranularity: GranularityNode = {
        index: 1,
        description: '模块规约',
        filePath: path.join(rootModulePath, 'designment_info.txt'),
        nodeType: 'pseudo',
        isActive: true
    }
    fs.writeFileSync(path.join(rootModulePath, 'node.json'), JSON.stringify([rootGranularity], null, 4), 'utf8')

    const rootNode = new DirectoryNode(rootModuleName, rootModulePath, NodeType.Module, newProj, path.join(rootModulePath, 'content.txt'))
    newProj.children.push(rootNode)

    const modulesPath = path.join(absolutePath, 'modules.json')
    const ongoingPath = path.join(absolutePath, 'ongoing_leaf_modules.json')
    fs.writeFileSync(modulesPath, JSON.stringify([rootDescriptor], null, 2), 'utf8')
    fs.writeFileSync(ongoingPath, JSON.stringify([rootDescriptor], null, 2), 'utf8')

    dataProvider.localNodeTree.push(newProj)
    dataProvider.refresh(undefined)

    // 返回需求文件路径，供调用方自动打开编辑
    return filePath
}


/**
 * 将项目需求文件 (content.txt) 的首行同步为根模块 (Root) 的描述。
 * 在用户保存 content.txt 时调用。
 */
export async function syncRequirementToRootModule(projectAbsPath: string, firstLine: string): Promise<void> {
    const rootModulePath = path.join(projectAbsPath, 'Root')
    const rootContentPath = path.join(rootModulePath, 'content.txt')
    const rootDesignmentPath = path.join(rootModulePath, 'designment_info.txt')

    // 更新 Root/content.txt
    if (fs.existsSync(rootContentPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(rootContentPath, 'utf8'))
            data.description = firstLine
            fs.writeFileSync(rootContentPath, JSON.stringify(data, null, 2), 'utf8')
        } catch { /* 格式不符时跳过 */ }
    }

    // 更新 Root/designment_info.txt
    if (fs.existsSync(rootDesignmentPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(rootDesignmentPath, 'utf8'))
            data.description = firstLine
            fs.writeFileSync(rootDesignmentPath, JSON.stringify(data, null, 2), 'utf8')
        } catch { /* 格式不符时跳过 */ }
    }

    // 更新 modules.json 和 ongoing_leaf_modules.json 中 Root 的描述
    for (const filename of ['modules.json', 'ongoing_leaf_modules.json']) {
        const jsonPath = path.join(projectAbsPath, filename)
        if (!fs.existsSync(jsonPath)) continue
        try {
            const arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
            const rootMod = arr.find((m: any) => m.name === 'Root' || m.module_name === 'Root')
            if (rootMod) {
                rootMod.description = firstLine
                fs.writeFileSync(jsonPath, JSON.stringify(arr, null, 2), 'utf8')
            }
        } catch { /* 格式不符时跳过 */ }
    }
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

    const parentChildren = parent.children
    const index = parentChildren.indexOf(node)
    parentChildren.splice(index, 1)

    // If the parent now has no children, it becomes a leaf again.
    const parentBackToLeafModule = parentChildren.length === 0 && parent.type === NodeType.Module
    if (parentBackToLeafModule) {
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
        const parentModuleEntry = modulesEntries.find(entry => entry.name === getModuleFullName(parent))

        if (!parentModuleEntry) {
            throw new Error('Unexpected error: parent module entry not found in modules.json.')
        }

        ongoingLeafModulesEntries.push(parentModuleEntry)
    }

    // Handle dependencies.
    modulesEntries.forEach(entry => {
        const newDependencies = entry.dependencies.filter(dep => !dep.startsWith(moduleFullName))
        if (newDependencies.length < entry.dependencies.length && parentBackToLeafModule) {
            newDependencies.push(getModuleFullName(parent))
        }
        entry.dependencies = newDependencies
    })

    ongoingLeafModulesEntries.forEach(entry => {
        const newDependencies = entry.dependencies.filter(dep => !dep.startsWith(moduleFullName))
        if (newDependencies.length < entry.dependencies.length && parentBackToLeafModule) {
            newDependencies.push(getModuleFullName(parent))
        }
        entry.dependencies = newDependencies
    })

    // Write changes to each node's content file.
    const pseudoPath = settings.getAiPath()
    modulesEntries.forEach(entry => {
        const contentFilePath = path.join(pseudoPath, entry.path, 'content.txt')
        if (fs.existsSync(contentFilePath)) {
            fs.writeFileSync(contentFilePath, JSON.stringify(entry, null, 2), 'utf8')
        } else {
            throw new Error(`Content file not found for module ${entry.name} at path: ${contentFilePath}`)
        }
    })

    fs.writeFileSync(modulesJsonPath, JSON.stringify(modulesEntries, null, 2), 'utf8')
    fs.writeFileSync(ongoingLeafModulesJsonPath, JSON.stringify(ongoingLeafModulesEntries, null, 2), 'utf8')

    DesignmentTreeDataProvider.getInstance().refresh(parent)
}
