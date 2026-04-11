import assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
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

        // Backward compatibility: recover legacy projects created without a root module.
        designmentTreeDataProvider.localNodeTree.forEach(async (node) => {
            if (!(node instanceof DirectoryNode) || node.type !== NodeType.Project) {
                return
            }

            const hasModuleChild = node.children.some(
                (child) => child instanceof DirectoryNode && child.type === NodeType.Module
            )
            if (hasModuleChild) {
                return
            }

            const firstLine = (() => {
                const p = node.getContentFilePath()
                if (!p) return '项目根模块'
                try {
                    const content = fs.readFileSync(p, 'utf8').trim()
                    return content.split(/\r?\n/).find((line: string) => line.trim().length > 0) || '项目根模块'
                } catch {
                    return '项目根模块'
                }
            })()

            const rootContent = JSON.stringify({
                description: firstLine,
                dependencies: []
            }, null, 2)

            await designmentService.createModule(node, 'Root', rootContent)
        })

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

                const isLeafModule = selected instanceof DirectoryNode && selected.type === NodeType.Module && selected.isLeaf()
                if (selected.isRefinable() || isLeafModule) {
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

                if (!node.isLeaf()) {
                    vscode.window.showWarningMessage('第一版仅支持删除叶子模块。')
                    return
                }

                const projectPath = (() => {
                    let iter: DirectoryNode = node
                    while (iter.parent) iter = iter.parent
                    return iter.absolutePath
                })()

                await designmentService.discardRefinementFromModule(node)
                await designmentService.deleteModuleNode(node)
                await designmentService.resetFinalizedDesignState(projectPath)
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.editModuleDescription', async (node: DirectoryNode) => {
                if (node.type !== NodeType.Module || !node.isLeaf()) {
                    vscode.window.showWarningMessage('仅支持编辑叶子模块描述。')
                    return
                }

                const newDescription = await vscode.window.showInputBox({
                    prompt: `编辑模块 ${node.label} 的简短描述`,
                    value: '',
                    placeHolder: '输入用于设计审阅的自然语言描述'
                })

                if (newDescription === undefined) {
                    return
                }

                await designmentService.updateLeafModuleDescription(node, newDescription.trim())
                await designmentService.discardRefinementFromModule(node)
                const projectPath = (() => {
                    let iter: DirectoryNode = node
                    while (iter.parent) iter = iter.parent
                    return iter.absolutePath
                })()
                await designmentService.resetFinalizedDesignState(projectPath)
                designmentTreeDataProvider.refresh(node.parent)
                vscode.window.showInformationMessage('模块描述已更新，已回退到设计阶段。请重新执行“完成设计”。')
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

                const newModuleDescription = await vscode.window.showInputBox({
                    prompt: `Enter description for module ${newModuleName}`,
                    placeHolder: '模块职责描述（可选）'
                })
                if (newModuleDescription === undefined) return
                
                const desc = newModuleDescription.trim()
                const content = JSON.stringify({
                    description: desc || `${newModuleName} 模块`,
                    dependencies: []
                }, null, 2)

                await designmentService.createModule(selected, newModuleName, content)

                let projectNode: DirectoryNode = selected
                while (projectNode.parent) projectNode = projectNode.parent
                await designmentService.resetFinalizedDesignState(projectNode.absolutePath)
                vscode.window.showInformationMessage('新增模块成功，已回到设计阶段。请重新执行“完成设计”。')
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

                const requirementFilePath = await designmentService.createProject(newProjName)
                if (requirementFilePath) {
                    // 创建后自动打开需求文件，用户直接编辑
                    const doc = await vscode.workspace.openTextDocument(requirementFilePath)
                    await vscode.window.showTextDocument(doc)
                    vscode.window.showInformationMessage('请编辑项目需求文件，然后通过“创建子模块/划分子模块”开始设计。')
                }
            })
        )

        // 监听 project requirement (content.txt) 保存，兼容旧版 Root 模块同步逻辑
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(async (doc) => {
                const aiPath = settings.getAiPath()
                const relPath = path.relative(aiPath, doc.fileName)
                const parts = relPath.split(path.sep)

                // 仅处理 ProjectName/content.txt（两级路径）
                if (parts.length !== 2 || parts[1] !== 'content.txt') return

                const projectAbsPath = path.join(aiPath, parts[0])

                const projectNode = designmentTreeDataProvider.localNodeTree.find(
                    n => n instanceof DirectoryNode &&
                         path.resolve(n.absolutePath) === path.resolve(projectAbsPath)
                )
                if (!projectNode) return

                const firstLine = doc.getText().trim().split(/\r?\n/)
                    .find(line => line.trim().length > 0) || ''
                if (!firstLine) return

                await designmentService.syncRequirementToRootModule(projectAbsPath, firstLine)
                designmentTreeDataProvider.refresh(projectNode)
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.divideModule', async (node: DirectoryNode) => {

                if (node.type !== NodeType.Module) {
                    throw Error('Use module division on project node.')
                }

                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
                const customPrompt = await vscode.window.showInputBox({
                    prompt: '输入拆分方向提示词（可选）',
                    placeHolder: '例如：按可测试性拆分，尽量减少跨模块状态共享'
                })

                if (customPrompt === undefined) {
                    designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                    checkModuleDivisionButtonState()
                    return
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在划分模块...',
                    cancellable: false
                }, async (progress) => {
                    try {
                        await doModuleDivision(node, context, {
                            customPrompt,
                            candidateCount: 3
                        })
                        await designmentService.discardRefinementFromModule(node)
                        let projectNode: DirectoryNode = node
                        while (projectNode.parent) projectNode = projectNode.parent
                        await designmentService.resetFinalizedDesignState(projectNode.absolutePath)
                        designmentTreeDataProvider.refresh(node)
                        // [修改] 使用 progress.report 显示成功信息，并停留2秒
                        progress.report({ message: '模块划分成功！' });
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } catch (error) {
                        vscode.window.showErrorMessage(`模块划分失败: ${error}`)
                        console.error('Failed to divide module: ', error)
                    }
                })
                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
            })
        )

        // 完成设计：提取通用数据结构 → 生成增强描述 + 拓扑顺序 → 写入 leaf_modules.json
        // 这是一次性的项目级操作，将设计阶段收尾，为精化阶段做准备。
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.finalizeDesign', async (node: DirectoryNode) => {
                if (node.type !== NodeType.Project) {
                    throw Error('finalizeDesign must be used on a project node.')
                }

                designmentTreeDataProvider.switchBannedStateForWholeProject(node)
                checkModuleDivisionButtonState()
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: '正在完成设计...',
                    cancellable: false
                }, async (progress) => {
                    try {
                        // Step 1: 提取通用数据结构
                        progress.report({ message: '步骤 1/2：提取通用数据结构...' })
                        await getCommonDS(node, context)

                        // Step 2: LLM 生成增强模块描述 + 拓扑排序，写入 leaf_modules.json
                        progress.report({ message: '步骤 2/2：生成精化顺序与增强描述...' })
                        await getLeafModules(node.absolutePath, context)

                        designmentTreeDataProvider.refresh(node)
                        progress.report({ message: '设计完成！可以开始精化各模块。' })
                        await new Promise(resolve => setTimeout(resolve, 2000))
                    } catch (error) {
                        vscode.window.showErrorMessage(`完成设计失败: ${error}`)
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