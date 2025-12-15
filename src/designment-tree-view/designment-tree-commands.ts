import assert from 'assert'
import * as vscode from 'vscode'
import * as designmentService from './designment-tree-service'
import { DesignmentTreeDataProvider, DirectoryNode, NodeType } from './designment-tree-data-provider'
import { doModuleDivision, getCommonDS, getLeafModules } from './designment-tree-utils'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../granularity-view/create-granularity-panel'
import * as settings from '../settings/settings';


export async function createTreeView(context: vscode.ExtensionContext) {

    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openChatGPTView", async () => {
            const structureReady = await settings.ensureProjectStructure();
            
            if (structureReady) {
                openChatGPTView(context)
            }
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
                    selected instanceof DirectoryNode && selected.allowModuleDivisionButtonWhenSelected()
                )
                
                const contentPath = selected.getContentFilePath()
                if (contentPath) {
                    const doc = await vscode.workspace.openTextDocument(contentPath)
                    await vscode.window.showTextDocument(doc)
                }

                if (selected.isRefinable()) {
                    openGranularityWebview(selected.absolutePath)
                } else {
                    // If not refinable, close the granularity panel.
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

        // Register command for deleting module nodes.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.deleteModule', async (node: DirectoryNode) => {
                if (node.type !== NodeType.Module) {
                    throw Error('Use deleteModule command for project node.')
                }

                await designmentService.deleteModuleNode(node)
            })
        )

        // Command for deleting whole projects.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.deleteProject', async (node: DirectoryNode) => {
                if (node.type !== NodeType.Project) {
                    throw Error('Use deleteProject command for module node.')
                }

                await designmentService.deleteProjectNode(node)
            })
        )

        // Command for creating a new node under existing parent.
        // To be more specific, the node should not be a root node corresponding to a project.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createModule', async () => {

                const selected = treeView.selection[0]

                assert(selected && selected instanceof DirectoryNode, 'Selected node is not a directory node.')

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

                if (node.type !== NodeType.Module) {
                    throw Error('Use module division on project node.')
                }

                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
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
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.firstDivision', async (node: DirectoryNode) => {

                if (node.type !== NodeType.Project) {
                    throw Error('Use first division on module node.')
                }

                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在划分初始模块...',
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
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.extractCommonDataStructure', async (node: DirectoryNode) => {

                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
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
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.getLeafModules', async (node: DirectoryNode) => {
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在获取叶子模块...',
                    cancellable: false
                }, async () => {
                    try {
                        await getLeafModules(node.absolutePath, context)
                        designmentTreeDataProvider.refresh(node)
                        vscode.window.showInformationMessage('叶子模块获取成功！')
                    } catch (error) {
                        vscode.window.showErrorMessage('获取叶子模块失败。')
                        console.error('Failed to get leaf modules: ', error)
                    }
                })
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
            })
        )

        vscode.commands.executeCommand("setContext", "CodeToolBox.chatGPTView", true)

        function checkModuleDivisionButtonState() {
            const selected = treeView.selection[0]
            if (selected && treeView.selection.length === 1) {
                vscode.commands.executeCommand(
                    "setContext",
                    "CodeToolBox.enableCreateModule",
                    selected instanceof DirectoryNode && selected.allowModuleDivisionButtonWhenSelected()
                )
            }
        }
    })
}

