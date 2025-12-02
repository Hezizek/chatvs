import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { DesignmentTreeDataProvider, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import { doModuleDivision, getCommonDS, getLeafModules } from './designment-utils'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../granularity-view/create-granularity-panel'
import { GranularityRecord } from '../granularity-view/granularity-record'


export async function createTreeView(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openChatGPTView", async () => {
            openChatGPTView(context)
        })
    )
}

export async function revealTreeItem(nodePath: string) {
    const dir = path.dirname(nodePath)
    openGranularityWebview(dir)
}

const openChatGPTView = (context: vscode.ExtensionContext) => {
    vscode.commands.executeCommand("workbench.view.extension.CodeToolBox").then(() => {
        const designmentTreeDataProvider = DesignmentTreeDataProvider.getInstance()

        const treeView = vscode.window.createTreeView('CodeToolBox.chatGPTView', {
            treeDataProvider: designmentTreeDataProvider
        })

        context.subscriptions.push(treeView)

        // Listen to node selection.
        treeView.onDidChangeSelection(async event => {

            // When single node selected, we need to handle the click event.
            if (event.selection.length === 1) {

                const selected = event.selection[0]
                vscode.commands.executeCommand(
                    "setContext",
                    "CodeToolBox.enableCreateModule",
                    selected.hasChildren()
                )

                const contentPath = selected.getContentFilePath()
                const doc = await vscode.workspace.openTextDocument(contentPath)
                await vscode.window.showTextDocument(doc)

                if (selected.isRefinable()) {
                    openGranularityWebview(selected.absolutePath)
                } else {
                    // If non-leaf node, close the granularity panel.
                    disposeCurrentRecordAndCloseWebview()
                }

            } else {
                // Multiple or no selection, disable create module command.
                vscode.commands.executeCommand(
                    "setContext",
                    "CodeToolBox.enableCreateModule",
                    false
                )
            }
        })

        // Register commands for deleting node.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.deleteNode', async (node: DirectoryNode) => {

                // Deleting corresponding folder in fs.
                fs.rmSync(node.absolutePath, { recursive: true, force: true })

                const parentChildren = node.parent ? node.parent.children : designmentTreeDataProvider.localNodeTree
                const index = parentChildren.indexOf(node)
                parentChildren.splice(index, 1)
                designmentTreeDataProvider.refresh(node.parent)

            })
        )

        // Command for creating a new node under existing parent.
        // To be more specific, the node should not be a root node corresponding to a project.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createModule', async () => {

                const selected = treeView.selection[0]

                assert(selected.hasChildren(), 'Selected node is not a directory node.')

                const targetPath = selected.absolutePath
                const defaultName = "New Module"

                const newModuleName = await vscode.window.showInputBox({
                    prompt: 'Enter a new module name',
                    value: defaultName
                })

                // User cancel.
                if (!newModuleName) return

                // Create target dir and files in fs.
                const newModulePath = path.join(targetPath, newModuleName)
                const filePath = path.join(newModulePath, "content.txt")
                if (fs.existsSync(newModulePath)) {
                    vscode.window.showErrorMessage(`Module "${newModuleName}" already exists.`)
                    return
                }

                fs.mkdirSync(newModulePath, { recursive: true })
                fs.writeFileSync(filePath, "Empty content.")
        
                // TODO
                // 实例化一个临时的 Record 对象指向新目录
                const record = new GranularityRecord(newModulePath)
                // 添加第一条记录：指向刚创建的 content.txt
                const index = record.getCurrentIndex()
                record.addRecord(filePath, '粒度' + (index + 1), true)

                // 保存到 node.json 并释放
                record.dispose()

                const newNode = new DirectoryNode(newModuleName, newModulePath, NodeType.Module, selected)
                selected.children.push(newNode)

                designmentTreeDataProvider.refresh(selected)
            })
        )

        // Checked.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createProj', async () => {

                const targetPath = vscode.workspace.getConfiguration('ai').get<string>('path')
                const defaultName = "New Project"

                assert(targetPath, "Target file path in settings is not configured.")

                const newProjName = await vscode.window.showInputBox({
                    prompt: 'Enter a new project name',
                    value: defaultName
                })

                // User cancel.
                if (!newProjName) return

                // Create target dir and files in fs.
                const newProjPath = path.join(targetPath, newProjName)
                const filePath = path.join(newProjPath, "content.txt")
                
                if (fs.existsSync(newProjPath)) {
                    vscode.window.showErrorMessage(`Project "${newProjName}" already exists.`)
                    return
                }
                
                fs.mkdirSync(newProjPath, { recursive: true })
                fs.writeFileSync(filePath, "Empty content.")

                const newRoot = new DirectoryNode(newProjName, newProjPath, NodeType.Project)

                // When creating a new project, automtically create a project requirement node under it.
                const reqNode = new FileNode('Project Requirements', filePath, NodeType.Requirement, newRoot)
                newRoot.children.push(reqNode)
                designmentTreeDataProvider.localNodeTree.push(newRoot)
                
                designmentTreeDataProvider.refresh(undefined)
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.divideModule', async (node: DirectoryNode) => {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在划分模块...',
                    cancellable: false
                }, async () => {
                    try {
                        await doModuleDivision(node, context)
                        designmentTreeDataProvider.refresh(node)
                        vscode.window.showInformationMessage('模块划分成功！')
                    } catch (error) {
                        vscode.window.showErrorMessage('模块划分失败。')
                        console.error('Failed to divide module: ', error)
                    }
                })
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.extractCommonDataStructure', async (node: DirectoryNode) => {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在提取通用数据结构...',
                    cancellable: false
                }, async () => {
                    try {
                        await getCommonDS(node, context)
                        designmentTreeDataProvider.refresh(node)
                        vscode.window.showInformationMessage('通用数据结构提取成功！')
                    } catch (error) {
                        vscode.window.showErrorMessage('提取通用数据结构失败。')
                        console.error('Failed to extract common data structure: ', error)
                    }
                })
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.getLeafModules', async (node: DirectoryNode) => {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在获取叶子模块...',
                    cancellable: false
                }, async () => {
                    try {
                        await getLeafModules(node.absolutePath, context)
                        // TODO: refresh?
                        vscode.window.showInformationMessage('叶子模块获取成功！')
                    } catch (error) {
                        vscode.window.showErrorMessage('获取叶子模块失败。')
                        console.error('Failed to get leaf modules: ', error)
                    }
                })
            })
        )

        vscode.commands.executeCommand("setContext", "CodeToolBox.chatGPTView", true)
    })
}



// The following functions are exposed to the granularity view module, for handling seq.json file for the whole project.

interface LeafModule {
    relativePath: string,
    status: 'completed' | 'ongoing' | 'pending'
}

export function getModuleSequence(): LeafModule[] {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    if (!aiPath) return []
    
    // 假设 seq.json 位于插件目录下
    const seqPath = 'D:/Directory/code/chatvs/chatvs/seq.json'
    if (fs.existsSync(seqPath)) {
        try {
            const content = fs.readFileSync(seqPath, 'utf8')
            return JSON.parse(content)
        } catch (e) {
            console.error('读取 seq.json 失败:', e)
        }
    }
    return []
}

// Set the module of index id to 'ongoing'.
// That also means setting the preceding modules to 'completed', the later sequence to 'pending'. 
export function setOnGoingModule(id: number) {
    const moduleSequence = getModuleSequence()

    if (id < 0 || id > moduleSequence.length) {
        console.warn("Invalid module index: ", id)
        return
    }

    for (let i = 0; i < moduleSequence.length; i++) {
        if (i < id) {
            moduleSequence[i].status = 'completed'
        } else if (i === id) {
            moduleSequence[i].status = 'ongoing'
        } else {
            moduleSequence[i].status = 'pending'
        }
    }

    // Write the change back to json file.
    const seqPath = 'D:/Directory/code/chatvs/chatvs/seq.json'
    if (fs.existsSync(seqPath)) {
        fs.writeFileSync(seqPath, JSON.stringify(moduleSequence))
    }
}
