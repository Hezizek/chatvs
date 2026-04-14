import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as Diff from 'diff'
import * as settings from '../settings/settings'
import * as openaiHelper from '../openai/openai-helper'
import { GranularityViewProvider } from './granularity-view-provider'
import { GranularityNode, GranularityRecord } from './granularity-record'
import { cleanLLMResponse, getHumanJsonPath, LineData } from './granularity-view-utils'
import { initialProject, removeProject } from '../tools/project-initializer'
import { writeModule } from '../tools/module-writer'
import { updateRootLaunchConfig, removeRootLaunchConfig } from '../tools/launch-config-updater'
import { encoding_for_model } from "@dqbd/tiktoken";
import { FileNode, NodeType } from '../designment-tree-view/designment-tree-data-provider'
import * as designmentService from '../designment-tree-view/designment-tree-service'
import { doModuleDivision } from '../designment-tree-view/designment-tree-utils'
import { DesignmentTreeDataProvider, DirectoryNode } from '../designment-tree-view/designment-tree-data-provider'


export let currentRecord: GranularityRecord | null = null

const refineHighlightType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: '#CCA700',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})

export const refinementDiagnostics = vscode.languages.createDiagnosticCollection('refinement');
const CONFIRMED_LEAF_MODULES_FILE = 'confirmed_leaf_modules.json'

function appendCustomPrompt(basePrompt: string, customPrompt?: string): string {
    const cleaned = (customPrompt || '').trim()
    if (!cleaned) {
        return basePrompt
    }

    return `${basePrompt}\n\n# User Extra Instruction\n${cleaned}`
}

function getModuleName(mod: any): string {
    return mod.name || mod.module_name || ''
}

function findNodeByAbsolutePath(nodes: any[], absolutePath: string): DirectoryNode | null {
    const normalizedTarget = path.resolve(absolutePath)
    for (const node of nodes) {
        if (node instanceof DirectoryNode && path.resolve(node.absolutePath) === normalizedTarget) {
            return node
        }
        if (node instanceof DirectoryNode && node.children.length > 0) {
            const found = findNodeByAbsolutePath(node.children, absolutePath)
            if (found) return found
        }
    }
    return null
}

    function getProjectPathFromNode(node: DirectoryNode): string {
        let iter: DirectoryNode = node
        while (iter.parent) {
            iter = iter.parent
        }
        return iter.absolutePath
    }

function getCurrentModuleMeta(record: GranularityRecord): {
    projectRootPath: string
    relativePath: string
    seqIndex: number
    status: 'completed' | 'ongoing' | 'pending'
    allCompleted: boolean
} {
    const projectRootPath = record.projectHandler.rootPath
    const rootPath = record.getRootPath()
    const aiPath = settings.getAiPath()
    const relativePath = path.relative(aiPath, rootPath)
    const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json')

    if (fs.existsSync(leafModulesPath)) {
        const leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8')) as any[]
        const seqIndex = leafModules.findIndex((mod: any) => mod.path === relativePath)
        const status = seqIndex >= 0 ? (leafModules[seqIndex].status || 'pending') : 'pending'
        const allCompleted = leafModules.length > 0 && leafModules.every((mod: any) => mod.status === 'completed')
        return { projectRootPath, relativePath, seqIndex, status, allCompleted }
    }

    return { projectRootPath, relativePath, seqIndex: -1, status: 'pending', allCompleted: false }
}

async function prepareModuleMutation(record: GranularityRecord): Promise<boolean> {
    const meta = getCurrentModuleMeta(record)
    if (meta.seqIndex < 0) {
        vscode.window.showWarningMessage('当前模块不在精化顺序中，无法执行精化。')
        return false
    }

    if (meta.status === 'pending') {
        vscode.window.showWarningMessage('请先完成前置模块确认，再精化当前模块。')
        return false
    }

    if (meta.status === 'completed') {
        await designmentService.discardRefinementFromModulePath(meta.projectRootPath, meta.relativePath, false)
    }

    return true
}

/**
 * 拆分指定绝对路径的叶子模块。
 * 拆分后当前精化面板指向该模块的 Record 失效，因此关闭面板并提示用户重新选择子节点。
 */
async function splitModuleByAbsPath(
    moduleAbsPath: string,
    customPrompt: string,
    context: vscode.ExtensionContext
): Promise<void> {
    const treeProvider = DesignmentTreeDataProvider.getInstance()
    const treeNode = findNodeByAbsolutePath(treeProvider.localNodeTree, moduleAbsPath)

    if (!treeNode || treeNode.type !== NodeType.Module || !treeNode.isLeaf()) {
        vscode.window.showWarningMessage('当前节点不是可拆分的叶子模块。')
        return
    }

    treeProvider.switchBannedStateForWholeProject(treeNode)
    try {
        await doModuleDivision(treeNode, context, { customPrompt, candidateCount: 3 })
        await designmentService.discardRefinementFromModule(treeNode)
        treeProvider.refresh(treeNode)

        // 拆分后当前面板已失效，关闭并提示用户选择子节点
        if (currentRecord && path.resolve(currentRecord.getRootPath()) === path.resolve(moduleAbsPath)) {
            disposeCurrentRecordAndCloseWebview()
        } else if (currentRecord) {
            // 当前面板是其他模块，仅刷新视图中的模块树
            currentRecord.fireUpdate()
        }

        vscode.window.showInformationMessage('模块拆分完成，请在左侧树中选择子模块继续操作。')
    } catch (error) {
        vscode.window.showErrorMessage(`拆分失败: ${error}`)
    } finally {
        treeProvider.switchBannedStateForWholeProject(treeNode)
    }
}

// Invoked in activation function.
export function registerWebviewForGranularityPanel(context: vscode.ExtensionContext) {

    const provider = new GranularityViewProvider(context.extensionUri)

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('GranularityView', provider)
    )

    context.subscriptions.push(refinementDiagnostics);

    // Register webview commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.switchGranularity', (payload) => {
            if (payload && typeof payload.index === 'number' && currentRecord) {
                currentRecord.switchTo(payload.index)
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.switchModule', async (payload) => {
            const modulePath: string = payload?.modulePath || ''
            if (!modulePath) return

            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            if (!fs.existsSync(moduleAbsPath)) {
                vscode.window.showWarningMessage('目标模块路径不存在。')
                return
            }

            openGranularityWebview(moduleAbsPath)
            const contentPath = path.join(moduleAbsPath, 'content.txt')
            if (fs.existsSync(contentPath)) {
                const doc = await vscode.workspace.openTextDocument(contentPath)
                await vscode.window.showTextDocument(doc)
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.createChildModuleByPath', async (payload) => {
            const modulePath: string = payload?.modulePath || ''
            const moduleName: string = (payload?.moduleName || '').trim()
            const moduleDescription: string = (payload?.moduleDescription || '').trim()
            if (!modulePath || !moduleName) return

            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            const treeProvider = DesignmentTreeDataProvider.getInstance()
            const parentNode = findNodeByAbsolutePath(treeProvider.localNodeTree, moduleAbsPath)

            if (!parentNode || parentNode.type !== NodeType.Module) {
                vscode.window.showWarningMessage('仅支持在模块节点下新增子模块。')
                return
            }

            const content = JSON.stringify({
                description: moduleDescription || `${moduleName} 模块`,
                dependencies: []
            }, null, 2)

            await designmentService.createModule(parentNode, moduleName, content)
            await designmentService.resetFinalizedDesignState(getProjectPathFromNode(parentNode))
            treeProvider.refresh(parentNode)

            if (currentRecord) {
                currentRecord.fireUpdate()
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.evolve', async (payload) => {
            const template = payload?.template || 'globalDetailed'
            const customPrompt = payload?.customPrompt || ''
            const language = payload?.language || 'python'

            if (template === 'globalDetailed') {
                await vscode.commands.executeCommand('refinement.globalRefine', {
                    refineLevel: 'detailed',
                    customPrompt
                })
                return
            }

            if (template === 'globalCoarse') {
                await vscode.commands.executeCommand('refinement.globalRefine', {
                    refineLevel: 'coarse',
                    customPrompt
                })
                return
            }

            if (template === 'local') {
                await vscode.commands.executeCommand('refinement.localRefine', {
                    customPrompt
                })
                return
            }

            if (template === 'generateCode') {
                assert(currentRecord, 'No usable record for granularity panel.')
                const meta = getCurrentModuleMeta(currentRecord)
                if (!meta.allCompleted) {
                    vscode.window.showWarningMessage('第一版中仅在全部模块伪代码确认后允许生成代码。')
                    return
                }

                await vscode.commands.executeCommand('refinement.generateCode', {
                    language,
                    customPrompt
                })
                return
            }

            vscode.window.showWarningMessage(`未知精化模板: ${template}`)
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.confirmEvolution', async () => {
            assert(currentRecord, 'No usable record for granularity panel.')

            const targetRecord = currentRecord
            const rootPath = targetRecord.getRootPath()
            const projectRootPath = targetRecord.projectHandler.rootPath
            const aiPath = settings.getAiPath()
            const relativePath = path.relative(aiPath, rootPath)
            const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json')

            // leaf_modules.json 必须已通过"完成设计"操作生成，否则提示用户。
            if (!fs.existsSync(leafModulesPath)) {
                vscode.window.showWarningMessage('请先在左侧项目节点上右键选择"完成设计（提取数据结构 + 生成精化顺序）"，生成精化顺序后再确认模块。')
                return
            }

            const leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
            const seqIndex = leafModules.findIndex((mod: any) => mod.path === relativePath)
            if (seqIndex < 0) {
                vscode.window.showWarningMessage('当前模块未在叶子模块顺序中找到，无法确认。')
                return
            }

            saveConfirmedSnapshot(projectRootPath, leafModules)
            targetRecord.projectHandler.setOnGoingModule(seqIndex + 1)
            targetRecord.fireUpdate()
            vscode.window.showInformationMessage('当前模块精化已完成，已推进到下一待处理模块。')
        })
    )

    // 扩写模块描述：以简述为输入，LLM 生成详尽描述，替代原"结束设计阶段"的副作用
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.expandDescription', async (payload) => {
            assert(currentRecord, 'No usable record for granularity panel.')
            const modulePath: string = payload?.modulePath || ''
            if (!modulePath) return

            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            const treeProvider = DesignmentTreeDataProvider.getInstance()
            const treeNode = findNodeByAbsolutePath(treeProvider.localNodeTree, moduleAbsPath)

            if (!treeNode || !treeNode.isLeaf()) {
                vscode.window.showWarningMessage('仅支持扩写叶子模块描述。')
                return
            }

            // 读取模块当前描述（从 content.txt 中 JSON 的 description 字段）
            const contentPath = path.join(moduleAbsPath, 'content.txt')
            if (!fs.existsSync(contentPath)) {
                vscode.window.showWarningMessage('未找到模块内容文件。')
                return
            }

            let currentDesc = ''
            try {
                const raw = fs.readFileSync(contentPath, 'utf8')
                const parsed = JSON.parse(raw)
                currentDesc = parsed.description || raw
            } catch {
                currentDesc = fs.readFileSync(contentPath, 'utf8')
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在扩写模块描述...',
                cancellable: false
            }, async (progress) => {
                try {
                    const systemPrompt = '你是一个软件架构师。请将用户给出的模块简述扩写为更详尽的职责描述（2-4句话），保持技术性和准确性，直接输出描述文本，不加任何额外说明。'
                    const userPrompt = `模块简述：\n${currentDesc}`
                    const expanded = await openaiHelper.callOpenAIForJSON(systemPrompt, userPrompt)
                    const cleanedDesc = expanded.trim()

                    await designmentService.updateLeafModuleDescription(treeNode, cleanedDesc)
                    await designmentService.discardRefinementFromModulePath(
                        currentRecord!.projectHandler.rootPath, modulePath, true
                    )
                    treeProvider.refresh(treeNode.parent)
                    currentRecord!.fireUpdate()

                    progress.report({ message: '描述扩写完成！' })
                    await new Promise(resolve => setTimeout(resolve, 1500))
                } catch (error) {
                    vscode.window.showErrorMessage(`扩写描述失败: ${error}`)
                }
            })
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.updateModuleDescriptionByPath', async (payload) => {
            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord = currentRecord
            const modulePath: string = payload?.modulePath || ''
            const description: string = (payload?.description || '').trim()

            if (!modulePath) {
                return
            }

            const projectRootPath = targetRecord.projectHandler.rootPath
            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            const treeProvider = DesignmentTreeDataProvider.getInstance()
            const treeNode = findNodeByAbsolutePath(treeProvider.localNodeTree, moduleAbsPath)

            if (!treeNode || treeNode.type !== NodeType.Module) {
                vscode.window.showWarningMessage('仅支持编辑模块节点描述。')
                return
            }

            await designmentService.updateLeafModuleDescription(treeNode, description)
            await designmentService.discardRefinementFromModulePath(projectRootPath, modulePath, true)
            treeProvider.refresh(treeNode.parent)
            targetRecord.fireUpdate()
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.splitCurrentModule', async (payload) => {
            assert(currentRecord, 'No usable record for granularity panel.')
            const targetPath = currentRecord.getRootPath()
            await splitModuleByAbsPath(targetPath, payload?.customPrompt || '', context)
        })
    )

    // 拆分设计树中指定路径的叶子模块（由面板设计树"拆分"按钮触发）
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.splitModuleByPath', async (payload) => {
            const modulePath: string = payload?.modulePath || ''
            const customPrompt: string = payload?.customPrompt || ''
            if (!modulePath) return

            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            await splitModuleByAbsPath(moduleAbsPath, customPrompt, context)
        })
    )

    // 打开设计树中指定模块的内容文件（由面板节点点击触发）
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.openModuleFile', async (payload) => {
            const modulePath: string = payload?.modulePath || ''
            if (!modulePath) return
            const aiPath = settings.getAiPath()
            const contentPath = path.join(aiPath, modulePath, 'content.txt')
            if (!fs.existsSync(contentPath)) return
            const doc = await vscode.workspace.openTextDocument(contentPath)
            await vscode.window.showTextDocument(doc)
        })
    )

    // 预览内置精化提示词的系统 Prompt 文件（在编辑器中以只读方式打开）
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.previewTemplate', async (payload) => {
            const template: string = payload?.template || ''
            const templateFileMap: Record<string, string> = {
                globalDetailed: '细粒度精化Prompt.md',
                globalCoarse: '粗粒度精化prompt.md',
                local: '局部精化prompt.md',
                generateCode: 'generateCode.md',
                extractCommonDS: 'commonDataStructure.md'
            }
            const fileName = templateFileMap[template]
            if (!fileName) {
                vscode.window.showWarningMessage(`未找到模板 "${template}" 对应的提示词文件。`)
                return
            }
            const filePath = path.join(context.extensionUri.fsPath, 'resources', 'prompts', fileName)
            if (!fs.existsSync(filePath)) {
                vscode.window.showWarningMessage(`提示词文件不存在: ${fileName}`)
                return
            }
            const doc = await vscode.workspace.openTextDocument(filePath)
            await vscode.window.showTextDocument(doc, { preview: true })
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.deleteCurrentModule', async () => {
            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord = currentRecord
            const targetPath = targetRecord.getRootPath()
            const treeProvider = DesignmentTreeDataProvider.getInstance()
            const treeNode = findNodeByAbsolutePath(treeProvider.localNodeTree, targetPath)

            if (!treeNode || treeNode.type !== NodeType.Module || !treeNode.isLeaf()) {
                vscode.window.showWarningMessage('当前模块不是可删除叶子模块。')
                return
            }

            await designmentService.discardRefinementFromModule(treeNode)
            await designmentService.deleteModuleNode(treeNode)
            disposeCurrentRecordAndCloseWebview()
            vscode.window.showInformationMessage('当前叶子模块已删除。')
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.deleteModuleByPath', async (payload) => {
            assert(currentRecord, 'No usable record for granularity panel.')
            const modulePath: string = payload?.modulePath || ''
            if (!modulePath) return

            const aiPath = settings.getAiPath()
            const moduleAbsPath = path.join(aiPath, modulePath)
            const treeProvider = DesignmentTreeDataProvider.getInstance()
            const treeNode = findNodeByAbsolutePath(treeProvider.localNodeTree, moduleAbsPath)

            if (!treeNode || treeNode.type !== NodeType.Module) {
                vscode.window.showWarningMessage('未找到可删除的模块节点。')
                return
            }

            const projectRootPath = getProjectPathFromNode(treeNode)
            await designmentService.discardRefinementFromModulePath(projectRootPath, modulePath, true)
            await designmentService.deleteModuleNode(treeNode)
            await designmentService.resetFinalizedDesignState(projectRootPath)

            if (currentRecord && path.resolve(currentRecord.getRootPath()) === path.resolve(moduleAbsPath)) {
                disposeCurrentRecordAndCloseWebview()
                return
            }

            if (currentRecord) {
                currentRecord.fireUpdate()
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.json2pse', async () => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord
            const ready = await prepareModuleMutation(targetRecord)
            if (!ready) {
                return
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在将JSON设计转换为伪代码...',
                cancellable: false
            }, async (progress) => {
                try {
                    const rootPath = targetRecord.getRootPath()
                    const lastNode = targetRecord.getLastNode()
                    const targetFilePath = lastNode.filePath
                    const fileContent = fs.readFileSync(targetFilePath, 'utf8')

                    // 获取项目根路径并构建通用数据结构路径
                    const projectRootPath = targetRecord.projectHandler.rootPath
                    const commonDSPath = path.join(projectRootPath, 'common_data_structures.json')

                    const prompt = await openaiHelper.getJson2PsePrompt(fileContent, rootPath, commonDSPath)

                    // It will take long here, where currentRecord may change.
                    const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)

                    const timestamp = Date.now()
                    const generatedFilePath = path.join(rootPath, `pseudotrans_json2pse_${timestamp}.txt`)

                    fs.writeFileSync(generatedFilePath, result, 'utf8')
                    targetRecord.appendNode(generatedFilePath, '伪代码 ' + lastNode.index, 'pseudo', false)

                    // Switch back to the corresponding module.
                    currentRecord = targetRecord
                    currentRecord.fireUpdate()

                    // 成功：更新消息并停留1秒
                    progress.report({ message: 'JSON转伪代码完成！' });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (err) {
                    // 失败：显示常驻错误消息
                    vscode.window.showErrorMessage(`JSON转伪代码失败: ${err}`);
                }
            });
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.globalRefine', async (payload) => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord
            const ready = await prepareModuleMutation(targetRecord)
            if (!ready) {
                return
            }

            const refineLevel = payload && payload.refineLevel ? payload.refineLevel : 'medium'
            const customPrompt = payload && payload.customPrompt ? payload.customPrompt : ''
            const levelText = refineLevel === 'detailed' ? '细致' : refineLevel === 'coarse' ? '粗糙' : '中等';

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在执行全局精化（${levelText}）...`,
                cancellable: false
            }, async (progress) => {
                try {
                    const rootPath = targetRecord.getRootPath()
                    const lastNode = targetRecord.getLastNode()
                    const targetFilePath = lastNode.filePath
                    const fileContent = fs.readFileSync(targetFilePath, 'utf8')

                    // 获取项目根路径并构建通用数据结构路径
                    const projectRootPath = targetRecord.projectHandler.rootPath
                    const commonDSPath = path.join(projectRootPath, 'common_data_structures.json')

                    let prompt
                    if (refineLevel === 'coarse') {
                        prompt = await openaiHelper.getGlobalRefinePromptCoarse(fileContent, rootPath, commonDSPath)
                    } else {
                        // 默认使用 detailed（较细）
                        prompt = await openaiHelper.getGlobalRefinePromptDetailed(fileContent, rootPath, commonDSPath)
                    }

                    // It will take long here, where currentRecord may change.
                    const userPrompt = appendCustomPrompt(prompt.user, customPrompt)
                    const result = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt, undefined, undefined)
                    const timestamp = Date.now()
                    const generatedFilePath = path.join(rootPath, `pseudotrans_global_refined_${timestamp}.txt`)

                    fs.writeFileSync(generatedFilePath, result, 'utf8')
                    targetRecord.appendNode(generatedFilePath, '伪代码 ' + lastNode.index, 'pseudo', false)

                    // Switch back to the corresponding module.
                    currentRecord = targetRecord
                    currentRecord.fireUpdate()

                    // 成功：更新消息并停留1秒
                    progress.report({ message: '全局精化完成！' });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (err) {
                    vscode.window.showErrorMessage(`全局精化失败: ${err}`);
                }
            });
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.localRefine', async (payload) => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord
            const ready = await prepareModuleMutation(targetRecord)
            if (!ready) {
                return
            }

            // There must be an active editor which corresponds to the last granularity.
            const editor = vscode.window.activeTextEditor
            const lastNode = targetRecord.getLastNode()
            const targetFilePath = lastNode.filePath

            if (!editor || path.relative(targetFilePath, editor.document.fileName) !== '' || editor.selection.isEmpty) {
                vscode.window.showWarningMessage('局部精化前，请先打开模块最新伪代码文件并选中要精化的部分。')
                return
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在执行局部精化...',
                cancellable: false
            }, async (progress) => {
                try {
                    const selection = editor.selection
                    const rootPath = targetRecord.getRootPath()
                    const sourceJsonPath = getHumanJsonPath(editor.document.fileName)
                    const fileContent = editor.document.getText()
                    const selectedCode = editor.document.getText(selection)
                    // 注意：VS Code 的 line 是从 0 开始的，这里 +1 可能是为了 Prompt 显示
                    const startLine = selection.start.line + 1
                    const endLine = selection.end.line + 1

                    // 获取项目根路径并构建通用数据结构路径
                    const projectRootPath = targetRecord.projectHandler.rootPath
                    const commonDSPath = path.join(projectRootPath, 'common_data_structures.json')

                    const customPrompt = payload && payload.customPrompt ? payload.customPrompt : ''
                    const prompt = await openaiHelper.getLocalRefinePrompt(fileContent, startLine, endLine, selectedCode, rootPath, commonDSPath)
                    const userPrompt = appendCustomPrompt(prompt.user, customPrompt)
                    const result = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt)
                    const refinedContent = cleanLLMResponse(result)

                    const timestamp = Date.now()
                    const generatedFilePath = path.join(rootPath, `pseudotrans_local_refined_${timestamp}.txt`)

                    let oldStatus: LineData[] = []
                    if (fs.existsSync(sourceJsonPath)) {
                        oldStatus = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf-8'))
                    }

                    const changes = Diff.diffLines(fileContent, refinedContent)

                    const highlightRanges: { start: number, end: number }[] = []
                    let newStatus: LineData[] = []

                    let currentOffset = 0; // 追踪新文件 (refinedContent) 的字符偏移量
                    let oldLineIndex = 0; // 追踪旧文件当前处理到的行号

                    changes.forEach(part => {
                        const lineCount = part.count || 0
                        const textLength = part.value.length

                        if (part.added) {
                            highlightRanges.push({
                                start: currentOffset,
                                end: currentOffset + textLength
                            })

                            for (let i = 0; i < lineCount; i++) {
                                newStatus.push({ type: 0, content: '' })
                            }

                            currentOffset += textLength

                        } else if (part.removed) {
                            oldLineIndex += lineCount

                        } else {
                            for (let i = 0; i < lineCount; i++) {
                                if (oldLineIndex < oldStatus.length) {
                                    newStatus.push({
                                        type: oldStatus[oldLineIndex].type,
                                        content: ''
                                    })
                                } else {
                                    newStatus.push({ type: 0, content: '' })
                                }
                                oldLineIndex++
                            }

                            currentOffset += textLength
                        }
                    })

                    const refinedLines = refinedContent.split(/\r?\n/)
                    if (refinedContent.endsWith('\n') && refinedLines.length > newStatus.length) {
                        refinedLines.pop()
                    }

                    newStatus.forEach((status, index) => {
                        if (index < refinedLines.length) {
                            status.content = refinedLines[index]
                        }
                    })

                    const newJsonPath = getHumanJsonPath(generatedFilePath)

                    fs.writeFileSync(newJsonPath, JSON.stringify(newStatus, null, 2), 'utf-8')
                    fs.writeFileSync(generatedFilePath, refinedContent, 'utf8')

                    targetRecord.appendNode(generatedFilePath, '伪代码 ' + lastNode.index, 'pseudo', false, highlightRanges)

                    // Switch back to the corresponding module.
                    currentRecord = targetRecord
                    currentRecord.fireUpdate()

                    // 成功：更新消息并停留1秒
                    progress.report({ message: '局部精化完成！' });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (err) {
                    vscode.window.showErrorMessage(`局部精化失败: ${err}`)
                }
            });
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.rollback', async () => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord

            const currentIndex = targetRecord.getCurrentIndex()
            if (currentIndex < 0) {
                vscode.window.showWarningMessage('您还没有选择要回退到的伪代码记录。')
                return
            }

            const rootPath = targetRecord.getRootPath()
            const projectHandlerRoot = targetRecord.projectHandler.rootPath
            const projectName = path.basename(projectHandlerRoot)
            const aiPath = settings.getAiPath()
            const relativePath = path.relative(aiPath, rootPath)

            // todo: 携带语言信息
            const language = 'python'

            const leafModulesPath = path.join(projectHandlerRoot, 'leaf_modules.json')
            let leafModules: any[] = []
            if (fs.existsSync(leafModulesPath)) {
                try {
                    leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
                } catch (e) {
                    console.error('Error reading leaf_modules.json:', e)
                }
            }

            const seqIndex = leafModules.findIndex((mod: any) => mod.path === relativePath)
            const isFirstModule = (seqIndex === 0)
            const isLastModule = (seqIndex !== -1 && seqIndex === leafModules.length - 1)
            // 读取当前的 node.json，检查即将被移除的节点
            const nodeJsonPath = path.join(rootPath, 'node.json')
            if (fs.existsSync(nodeJsonPath)) {
                try {
                    const allNodes: GranularityNode[] = JSON.parse(fs.readFileSync(nodeJsonPath, 'utf8'))
                    // index 之后的节点都会被移除（currentIndex 是我们要回退到的目标）
                    const nodesToRemove = allNodes.slice(currentIndex + 1)

                    // 查找是否有 "code" 类型的节点被移除
                    const codeNode = nodesToRemove.find(n => n.nodeType === 'code')

                    if (codeNode) {
                        // 1. 如果是第一个模块，且回退掉了代码生成步骤 -> 删除整个代码项目
                        if (isFirstModule) {
                            const codeProjectRoot = path.join(settings.getCodesPath(), projectName)
                            await removeProject(codeProjectRoot)
                            // 1.1 除此之外还要删除树结构中显示的实际数据结构
                            const dataStructureNode = targetRecord.projectHandler.getDataStructureNode()
                            dataStructureNode.children = []
                            targetRecord.projectHandler.updateProjectTree()

                            vscode.window.showInformationMessage(`检测到首模块代码生成回退，已移除代码相关数据。`)
                        }

                        // 2. 如果是最后一个模块，且回退掉了代码生成步骤 -> 删除 Launch 配置
                        if (isLastModule) {
                            const projectPath = settings.getProjectPath()
                            await removeRootLaunchConfig(projectPath, projectName, language)
                            vscode.window.showInformationMessage(`检测到末模块代码生成回退，已移除相关调试配置。`)
                        }
                    }
                } catch (e) {
                    console.error('Error during rollback cleanup checks:', e)
                }
            }

            targetRecord.backTo(currentIndex, false)
            const currentNode = targetRecord.getCurrentNode()
            const description = currentNode ? currentNode.description : '未知伪代码'

            vscode.window.showInformationMessage(`当前模块已回退至` + description + `。`)

            const projectHandler = currentRecord.projectHandler

            try {
                const relativePath = path.relative(aiPath, rootPath)
                const projectRoot = projectHandler.rootPath
                const leafModulesPath = path.join(projectRoot, 'leaf_modules.json')
                let leafModules: any[] = []
                if (fs.existsSync(leafModulesPath)) {
                    leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
                }

                const seqIndex = leafModules.findIndex((mod: any) => mod.path === relativePath)

                if (seqIndex >= 0 && seqIndex < leafModules.length - 1) {

                    const laterModules = leafModules.slice(seqIndex + 1)
                    for (const module of laterModules) {
                        // 使用 module.path 构建路径
                        if (module.path) {
                            const moduleFullPath = path.join(aiPath, module.path)
                            const tempRecord = new GranularityRecord(moduleFullPath)
                            //判断变量module当前对应的模块是否为最后一个
                            const isLastModule = (module === laterModules[laterModules.length - 1])

                            if (isLastModule) {
                                // 判断是否有代码节点被移除
                                const lastNode = tempRecord.getLastNode()
                                if (lastNode.nodeType === 'code') {
                                    // 如果是最后一个模块，且回退掉了代码生成步骤 -> 删除 Launch 配置
                                    const projectPath = settings.getProjectPath()
                                    await removeRootLaunchConfig(projectPath, projectName, language)
                                    vscode.window.showInformationMessage(`检测到末模块代码生成回退，已移除相关调试配置。`)
                                }
                            }

                            tempRecord.backTo(0, false)
                            tempRecord.dispose()
                        }
                    }
                }

                const currentNode = currentRecord.getCurrentNode()
                if (!currentNode) {
                    throw Error('Unexpected error: no selected granularity to rollback to.')
                }

                // Synchronize seq.json file.
                projectHandler.setOnGoingModule(currentNode.nodeType === 'pseudo' ? seqIndex : seqIndex + 1)
                currentRecord.fireUpdate()

            } catch (error) {
                console.error('级联重置失败:', error)
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.generateCode', async (payload) => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord = currentRecord

            const language = payload && payload.language ? payload.language : 'python'
            const customPrompt = payload && payload.customPrompt ? payload.customPrompt : ''
            const aiPath = settings.getAiPath();

            const projectHandler = targetRecord.projectHandler
            const projectRootPath = projectHandler.rootPath
            const projectName = path.basename(projectRootPath)
            const codeProjectRoot = path.join(settings.getCodesPath(), projectName)

            const rootPath = targetRecord.getRootPath()
            const relativePath = path.relative(aiPath, rootPath)

            const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json')
            let leafModules: any[] = []
            if (fs.existsSync(leafModulesPath)) {
                leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
            }

            const seqIndex = leafModules.findIndex((mod: any) => mod.path === relativePath)
            const isLastModule = (seqIndex === leafModules.length - 1)


            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在生成 ${language} 代码...`,
                cancellable: false
            }, async (progress) => {
                try {
                    const rootPath = targetRecord.getRootPath()

                    // 无论当前是哪个模块，都先确保代码项目骨架存在。
                    progress.report({ message: '正在初始化项目环境...' });
                    await initialProject(codeProjectRoot, language);

                    // 数据结构文件按需懒生成：若缺失则补生成，避免依赖“必须从第一个模块开始”。
                    try {
                        const { checkActualDataStructureExists, generateActualDataStructure } = await import('../tools/actual-datastructure-generator.js')
                        let dsFilePath = checkActualDataStructureExists(codeProjectRoot, language)

                        if (!dsFilePath) {
                            progress.report({ message: '正在生成实际数据结构文件...' });
                            dsFilePath = await generateActualDataStructure(projectRootPath, codeProjectRoot, language, context)
                            console.log('[generateCode] 实际数据结构文件生成成功:', dsFilePath)
                        }

                        if (dsFilePath) {
                            // 将数据结构文件同步到树视图，避免重复插入同一路径节点。
                            try {
                                const dsNode = projectHandler.getDataStructureNode()
                                const normalizedDsPath = path.resolve(dsFilePath)
                                const existsInTree = dsNode.children.some(
                                    child => path.resolve(child.absolutePath) === normalizedDsPath
                                )

                                if (!existsInTree) {
                                    const dsFileNode = new FileNode(
                                        path.basename(dsFilePath),
                                        dsFilePath,
                                        NodeType.NormalFile,
                                        dsNode
                                    )
                                    dsNode.children.push(dsFileNode)
                                    projectHandler.updateProjectTree()
                                }
                            } catch (treeSyncError) {
                                console.warn('[generateCode] 数据结构节点同步到树失败:', treeSyncError)
                            }

                            progress.report({ message: `数据结构就绪: ${path.basename(dsFilePath)}，继续生成模块代码...` });
                        }
                    } catch (dsError) {
                        console.error('[generateCode] 生成实际数据结构文件失败:', dsError)
                        // 警告不作为致命错误，继续执行模块代码生成。
                        vscode.window.showWarningMessage(`生成实际数据结构文件失败: ${dsError}。若提示 common_data_structures.json 不存在，请先在左侧项目树执行“完成设计”。本次将继续生成模块代码。`)
                    }

                    progress.report({ message: `正在生成模块代码...` });

                    const lastNode = targetRecord.getLastNode()
                    const fileContent = fs.readFileSync(lastNode.filePath, 'utf8')
                    const prompt = await openaiHelper.getGenerateCodePrompt(fileContent, lastNode.description, language, rootPath)
                    const userPrompt = appendCustomPrompt(prompt.user, customPrompt)
                    const result = await openaiHelper.callOpenAIForJSON(prompt.system, userPrompt)
                    const generatedCode = cleanLLMResponse(result)
                    const rawModuleRelativePath = path.relative(projectRootPath, rootPath)
                    const relativeSegments = rawModuleRelativePath.split(path.sep).filter(Boolean)
                    const moduleRelativePath = relativeSegments[0] === 'Root'
                        ? (relativeSegments.length > 1 ? path.join(...relativeSegments.slice(1)) : '')
                        : rawModuleRelativePath
                    const generatedFilePath = await writeModule(
                        codeProjectRoot,
                        moduleRelativePath,
                        generatedCode,
                        language
                    );
                    const projectPath = settings.getProjectPath();

                    if (isLastModule) {
                        await updateRootLaunchConfig(projectPath, projectName, generatedFilePath, language);
                        vscode.window.showInformationMessage(`已更新调试配置: "Run ${projectName}"`);
                    }

                    targetRecord.appendNode(generatedFilePath, '实际代码（' + language + '）', 'code', false)

                    // Switch back to the corresponding module.
                    currentRecord = targetRecord
                    currentRecord.fireUpdate()

                    // 成功：更新消息并停留1秒
                    progress.report({ message: '代码生成成功！' });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (err) {
                    vscode.window.showErrorMessage(`代码生成失败: ${err}`)
                }
            });
        })
    )
}

// Open the granularity webview for a leaf node.
export function openGranularityWebview(rootPath: string) {

    // Save the current state of record.
    if (currentRecord) {
        currentRecord.dispose()
    }

    currentRecord = new GranularityRecord(rootPath)

    currentRecord.onDidChange(async (nodes: GranularityNode[]) => {

        refinementDiagnostics.clear()

        // Inform the webview to update UI.
        assert(currentRecord, 'No usable record for granularity panel.')
        const aiPath = settings.getAiPath()
        const relativePath = path.relative(aiPath, rootPath)

        const projectRoot = currentRecord.projectHandler.rootPath
        const projectName = path.basename(projectRoot)
        const leafModulesPath = path.join(projectRoot, 'leaf_modules.json')
        const projectRequirementPath = path.join(projectRoot, 'content.txt')
        const designReady = fs.existsSync(leafModulesPath)

        let leafModules: any[] = []
        let modulesFallback: any[] = []
        let targetMod: any = null

        if (fs.existsSync(leafModulesPath)) {
            leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
            targetMod = leafModules.find((mod: any) => mod.path === relativePath)
        } else {
            // leaf_modules.json 尚不存在，回退到 ongoing_leaf_modules.json。
            // 注意：不使用 modules.json，因为它包含所有模块（含非叶子），会导致拓扑顺序混乱。
            const ongoingPath = path.join(projectRoot, 'ongoing_leaf_modules.json')
            if (fs.existsSync(ongoingPath)) {
                const ongoing = JSON.parse(fs.readFileSync(ongoingPath, 'utf8'))
                modulesFallback = ongoing
                const mod = ongoing.find((m: any) => m.path === relativePath)
                if (mod) targetMod = mod
            }
        }

        // 如果找不到该模块（例如已被拆分），发送空状态，让前端显示提示
        if (!targetMod) {
            // 此时 modulesFallback 已是 ongoing_leaf_modules.json 内容（仅叶子），可安全用作拓扑展示
            const sourceModulesFallback = leafModules.length > 0 ? leafModules : modulesFallback
            GranularityViewProvider.postMessage({
                type: 'updateView',
                data: {
                    nodes: [],
                    moduleSequence: sourceModulesFallback.map((mod: any, i: number) => ({
                        name: getModuleName(mod),
                        description: mod.description || '',
                        status: mod.status || (i === 0 ? 'ongoing' : 'pending'),
                        path: mod.path || ''
                    })),
                    confirmedSequence: [],
                    projectName: path.basename(currentRecord!.projectHandler.rootPath),
                    projectDescription: '',
                    currentModule: '',
                    moduleStatus: 'pending',
                    designReady: designReady,
                    moduleNotFound: true
                }
            })
            return
        }

        const currentModuleName = getModuleName(targetMod)
        const status = designReady ? (targetMod.status || 'ongoing') : 'pending'
        let projectDescription = ''
        if (fs.existsSync(projectRequirementPath)) {
            const content = fs.readFileSync(projectRequirementPath, 'utf8').trim()
            projectDescription = content
        }
        const sourceModules = leafModules.length > 0 ? leafModules : modulesFallback
        const moduleSequence = sourceModules.map((mod: any, index: number) => ({
            name: getModuleName(mod),
            description: mod.description || '',
            status: mod.status || (index === 0 ? 'ongoing' : 'pending'),
            path: mod.path || ''
        }))
        const confirmedSequence = loadConfirmedSnapshot(projectRoot).map((mod: any) => ({
            name: getModuleName(mod),
            description: mod.description || '',
            status: mod.status || 'pending',
            path: mod.path || ''
        }))

        // 获取当前粒度（根据活动节点的描述判断）
        const activeNode = nodes.find(n => n.isActive)
        // 粒度级别 = 节点index - 1 (因为第一个节点index=1表示粒度0)
        let currentGranularity = activeNode ? activeNode.index - 1 : -1

        GranularityViewProvider.postMessage({
            type: 'updateView',
            data: {
                nodes: nodes,
                moduleSequence: moduleSequence,
                confirmedSequence: confirmedSequence,
                projectName: projectName,
                projectDescription: projectDescription,
                currentModule: currentModuleName,
                moduleStatus: status,
                designReady: designReady,
                currentGranularity: currentGranularity
            }
        })

        // Open content for the active node if it exists.
        if (activeNode && activeNode.filePath) {
            try {
                const doc = await vscode.workspace.openTextDocument(activeNode.filePath)
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One
                })

                // 清除旧的诊断信息
                refinementDiagnostics.delete(doc.uri);

                // 读取确认状态 (_human.json)
                const humanJsonPath = getHumanJsonPath(activeNode.filePath);
                let lineStatuses: LineData[] = [];
                if (fs.existsSync(humanJsonPath)) {
                    try {
                        lineStatuses = JSON.parse(fs.readFileSync(humanJsonPath, 'utf8'));
                    } catch (e) {
                        console.error('Error reading human json:', e);
                    }
                }

                const rangesToDecorate: vscode.Range[] = [];
                const diagnostics: vscode.Diagnostic[] = [];

                if (activeNode.highlightRanges && activeNode.highlightRanges.length > 0) {
                    activeNode.highlightRanges.forEach(r => {
                        const startPos = doc.positionAt(r.start);
                        const endPos = doc.positionAt(r.end);

                        // 1. 背景高亮：依然保持 Range 整体高亮，这样背景色是连贯的
                        rangesToDecorate.push(new vscode.Range(startPos, endPos));

                        // 2. 诊断信息：改为逐行生成
                        for (let l = startPos.line; l <= endPos.line; l++) {
                            const textLine = doc.lineAt(l);
                            if (textLine.isEmptyOrWhitespace) {
                                continue;
                            }

                            // 检查当前行状态：1 代表 Human (Confirmed)
                            const isConfirmed = lineStatuses[l]?.type === 1;

                            if (!isConfirmed) {
                                // [核心修改] 使用 doc.lineAt(l).range 获取该行实际文本的范围
                                // 这样波浪线会紧贴代码文本，且显示更稳定
                                const textLine = doc.lineAt(l);

                                // 如果是空行，range 长度为 0，VS Code 通常不会在空行显示波浪线
                                // 这是符合预期的（空行不需要待确认标记）
                                if (!textLine.isEmptyOrWhitespace) {
                                    const diagnostic = new vscode.Diagnostic(
                                        textLine.range,
                                        '局部精化变更 (待确认)',
                                        vscode.DiagnosticSeverity.Warning
                                    );
                                    diagnostic.source = 'CodeSketcher';
                                    diagnostics.push(diagnostic);
                                }
                            }
                        }
                    });

                    editor.setDecorations(refineHighlightType, rangesToDecorate);
                } else {
                    editor.setDecorations(refineHighlightType, [])
                }

                refinementDiagnostics.set(doc.uri, diagnostics);

                if (rangesToDecorate.length > 0) {
                    editor.revealRange(rangesToDecorate[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                }
            } catch (err) {
                console.error('Cannot open file: ', err)
                vscode.window.showErrorMessage(`无法打开文件: ${activeNode.filePath}, 请检查路径是否存在。`)
            }
        }
    })

    currentRecord.fireUpdate()

    vscode.commands.executeCommand("workbench.view.extension.RefinementContainer")
}


export function disposeCurrentRecordAndCloseWebview() {
    if (currentRecord) {
        currentRecord.dispose()
        currentRecord = null
    }

    vscode.commands.executeCommand("workbench.action.closePanel")
}

function getConfirmedSnapshotPath(projectRootPath: string): string {
    return path.join(projectRootPath, CONFIRMED_LEAF_MODULES_FILE)
}

function saveConfirmedSnapshot(projectRootPath: string, modules: any[]): void {
    const targetPath = getConfirmedSnapshotPath(projectRootPath)
    fs.writeFileSync(targetPath, JSON.stringify(modules, null, 4), 'utf8')
}

function loadConfirmedSnapshot(projectRootPath: string): any[] {
    const targetPath = getConfirmedSnapshotPath(projectRootPath)
    if (!fs.existsSync(targetPath)) {
        return []
    }

    try {
        return JSON.parse(fs.readFileSync(targetPath, 'utf8'))
    } catch {
        return []
    }
}