import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as designmentService from './designment-tree-service'
import { DesignmentTreeDataProvider, DirectoryNode } from './designment-tree-data-provider'
import { doModuleDivision, getCommonDS, getLeafModules } from './designment-tree-utils'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../granularity-view/create-granularity-panel'
import { extractProject } from '../tools/project-extractor';


export async function createTreeView(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openChatGPTView", async () => {
            openChatGPTView(context)
        })
    )
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

                assert(selected && selected.hasChildren(), 'Selected node is not a directory node.')

                const defaultName = "New Module"
                const newModuleName = await vscode.window.showInputBox({
                    prompt: 'Enter a new module name',
                    value: defaultName
                })

                // User cancelled the input.
                if (!newModuleName) return
                
                await designmentService.createModule(selected, newModuleName)
            })
        )

        // Checked.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createProj', async () => {

                const defaultName = "New Project"
                const newProjName = await vscode.window.showInputBox({
                    prompt: 'Enter a new project name',
                    value: defaultName
                })

                // User cancelled the input.
                if (!newProjName) return

                await designmentService.createProject(newProjName)
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

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.extractProject', async (node: DirectoryNode) => {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在提取项目...',
                    cancellable: false
                }, async () => {
                    try {
                        // Currently hard-coded as python.
                        await extractProject(node.absolutePath, 'python')
                        vscode.window.showInformationMessage('项目提取成功！')
                    } catch (error) {
                        vscode.window.showErrorMessage(`项目提取失败。`)
                        console.error('Failed to extract project: ', error)
                    }
                })
            })
        )

        vscode.commands.executeCommand("setContext", "CodeToolBox.chatGPTView", true)
    })
}

