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
import { FileNode, DirectoryNode, NodeType } from '../designment-tree-view/designment-tree-data-provider'


export let currentRecord: GranularityRecord | null = null

const refineHighlightType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: '#CCA700',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})

export const refinementDiagnostics = vscode.languages.createDiagnosticCollection('refinement');

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
        vscode.commands.registerCommand('refinement.json2pse', async () => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord

            vscode.window.showInformationMessage('正在将JSON设计转换为伪代码...')

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

                // Open generated file.
                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

                // Switch back to the corresponding module.
                currentRecord = targetRecord
                currentRecord.fireUpdate()

                vscode.window.showInformationMessage(`JSON转伪代码完成，文件已保存: ${path.basename(generatedFilePath)}`)
            } catch (err) {
				vscode.window.showErrorMessage(`JSON转伪代码失败: ${err}`);
			}
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.globalRefine', async (payload) => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord

            const refineLevel = payload && payload.refineLevel ? payload.refineLevel : 'medium'

            vscode.window.showInformationMessage(`正在执行全局精化（${refineLevel === 'detailed' ? '细致' : refineLevel === 'coarse' ? '粗糙' : '中等'}）...`)

            try {
                const rootPath = targetRecord.getRootPath()
                const lastNode = targetRecord.getLastNode()
                const targetFilePath = lastNode.filePath
                const fileContent = fs.readFileSync(targetFilePath, 'utf8')

                // 获取项目根路径并构建通用数据结构路径
                const projectRootPath = targetRecord.projectHandler.rootPath
                const commonDSPath = path.join(projectRootPath, 'common_data_structures.json')

                let prompt
                let maxRefinementMultiples
                if (refineLevel === 'coarse') {
                    prompt = await openaiHelper.getGlobalRefinePromptCoarse(fileContent, rootPath, commonDSPath)
                    maxRefinementMultiples = 1.2
                } else {
                    // 默认使用 detailed（较细）
                    prompt = await openaiHelper.getGlobalRefinePromptDetailed(fileContent, rootPath, commonDSPath)
                    maxRefinementMultiples = -1
                }
                const encoder = encoding_for_model("gpt-3.5-turbo");
                const inputTokenNum =encoder.encode(fileContent).length;
                const maxTokens = Math.min(1024 * 8, Math.floor(inputTokenNum * maxRefinementMultiples));
                
                
                // It will take long here, where currentRecord may change.
                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user, undefined, undefined, maxTokens)
                const timestamp = Date.now()
                const generatedFilePath = path.join(rootPath, `pseudotrans_global_refined_${timestamp}.txt`)
            
                fs.writeFileSync(generatedFilePath, result, 'utf8')
                targetRecord.appendNode(generatedFilePath,  '伪代码 ' + lastNode.index, 'pseudo', false)

                // Open generated file.
                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

                // Switch back to the corresponding module.
                currentRecord = targetRecord
                currentRecord.fireUpdate()

                vscode.window.showInformationMessage(`全局精化完成，文件已保存: ${path.basename(generatedFilePath)}`)
            } catch (err) {
				vscode.window.showErrorMessage(`全局精化失败: ${err}`);
			}
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.localRefine', async (payload) => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord

            // There must be an active editor which corresponds to the last granularity.
            const editor = vscode.window.activeTextEditor
            const lastNode = targetRecord.getLastNode()
            const targetFilePath = lastNode.filePath

            if (!editor || path.relative(targetFilePath, editor.document.fileName) !== '' || editor.selection.isEmpty) {
                vscode.window.showWarningMessage('局部精化前，请先打开模块最新伪代码文件并选中要精化的部分。')
                return
            }

            vscode.window.showInformationMessage('正在执行局部精化...')

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
                
                const prompt = await openaiHelper.getLocalRefinePrompt(fileContent, startLine, endLine, selectedCode, rootPath, commonDSPath)
                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
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
                    /**
                     * part.count 通常就是行数，但为了保险起见，如果 diff 库行为不一致，也可以用 split 计算
                     * 只要文件不是特别巨大，split 开销可忽略
                     * 这里直接用 part.count (diff 库标准属性)
                     */
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
                vscode.window.showInformationMessage(`局部精化完成，文件已保存: ${path.basename(generatedFilePath)}`)

                // Open generated file.
                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

                // Switch back to the corresponding module.
                currentRecord = targetRecord
                currentRecord.fireUpdate()

            } catch (err) {
                vscode.window.showErrorMessage(`局部精化失败: ${err}`)
            }
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
                        // 尝试从描述中提取语言，例如 "实际代码（python）"
                        const match = codeNode.description.match(/实际代码（(.+)）/)
                        const language = match ? match[1] : 'python' // 默认回退值

                        // 1. 如果是第一个模块，且回退掉了代码生成步骤 -> 删除整个代码项目
                        if (isFirstModule) {
                            const codeProjectRoot = path.join(settings.getCodesPath(), projectName)
                            await removeProject(codeProjectRoot)
                            vscode.window.showInformationMessage(`检测到首模块代码生成回退，已重置代码项目目录。`)
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

            vscode.window.showInformationMessage(`当前模块已回退至`+description+`。`)

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
            const isFirstModule = (seqIndex === 0)
            const isLastModule = (seqIndex === leafModules.length - 1)
            

			vscode.window.showInformationMessage(`正在生成 ${language} 代码...`)

			try {
                const rootPath = targetRecord.getRootPath()
                
                // 如果是第一个模块，先生成实际数据结构文件
                if (isFirstModule) {
                    console.log('[generateCode] 检测到第一个模块，开始生成实际数据结构文件...')
                    await initialProject(codeProjectRoot, language);
                    
                    try {
                        const { generateActualDataStructure } = await import('../tools/actual-datastructure-generator.js')
                        const dsFilePath = await generateActualDataStructure(projectRootPath, codeProjectRoot,language, context)
                        vscode.window.showInformationMessage(`实际数据结构文件已生成: ${path.basename(dsFilePath)}`)
                        console.log('[generateCode] 实际数据结构文件生成成功:', dsFilePath)
                        
                        // 将生成的数据结构文件添加到树视图的 Common Data Structures 节点下
                        const dsNode = projectHandler.getDataStructureNode()
                        
                        // 创建数据结构文件节点
                        const dsFileNode = new FileNode(
                            path.basename(dsFilePath),
                            dsFilePath,
                            NodeType.NormalFile,
                            dsNode
                        )
                        
                        // 添加到 Common Data Structures 节点的子节点中
                        dsNode.children.push(dsFileNode)
                        
                        // 刷新树视图
                        projectHandler.updateProjectTree()

                    } catch (dsError) {
                        console.error('[generateCode] 生成实际数据结构文件失败:', dsError)
                        vscode.window.showWarningMessage(`生成实际数据结构文件失败: ${dsError}，将继续生成代码...`)
                    }
                }
                
                const lastNode = targetRecord.getLastNode()
				const fileContent = fs.readFileSync(lastNode.filePath, 'utf8')
				const prompt = await openaiHelper.getGenerateCodePrompt(fileContent, lastNode.description, language, rootPath)
				const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
				const generatedCode = cleanLLMResponse(result)
				const moduleRelativePath = path.relative(projectRootPath, rootPath);
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

                targetRecord.appendNode(generatedFilePath, '实际代码（'+language+'）', 'code', false)

                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One })

				vscode.window.showInformationMessage(`代码已生成，文件已保存: ${path.basename(generatedFilePath)}`)

                // Synchronize seq.json file.
                projectHandler.setOnGoingModule(seqIndex + 1)
                currentRecord = targetRecord
                currentRecord.fireUpdate()

			} catch (err) {
				vscode.window.showErrorMessage(`代码生成失败: ${err}`)
            }
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
    
    currentRecord.onDidChange(async ( nodes: GranularityNode[] ) => {

        refinementDiagnostics.clear()

        // Inform the webview to update UI.
        assert(currentRecord, 'No usable record for granularity panel.')
        const aiPath = settings.getAiPath()
        const relativePath = path.relative(aiPath, rootPath)
        
        const projectRoot = currentRecord.projectHandler.rootPath
        const leafModulesPath = path.join(projectRoot, 'leaf_modules.json')
        
        let leafModules: any[] = []
        let targetMod: any = null
        
        if (fs.existsSync(leafModulesPath)) {
            leafModules = JSON.parse(fs.readFileSync(leafModulesPath, 'utf8'))
            targetMod = leafModules.find((mod: any) => mod.path === relativePath)
        } else {
             // Fallback: Check modules.json if leaf_modules.json is missing or mod not found
            const modulesPath = path.join(projectRoot, 'modules.json')
            if (fs.existsSync(modulesPath)) {
                const modules = JSON.parse(fs.readFileSync(modulesPath, 'utf8'))
                // Try to find in modules.json
                 const mod = modules.find((m: any) => m.path === relativePath)
                 if (mod) targetMod = mod
            }
        }
        
        assert(targetMod, `无法在模块列表中找到模块: ${path.basename(rootPath)}`)
        
        const currentModuleName = targetMod.name || targetMod.module_name
        const status = targetMod.status || 'pending'
        const moduleSequence = leafModules.map((mod: any) => mod.name || mod.module_name)

        // 获取当前粒度（根据活动节点的描述判断）
        const activeNode = nodes.find(n => n.isActive)
        // 粒度级别 = 节点index - 1 (因为第一个节点index=1表示粒度0)
        let currentGranularity = activeNode ? activeNode.index - 1 : -1

        GranularityViewProvider.postMessage({
            type: 'updateView', 
            data: {
                nodes: nodes,
                moduleSequence: moduleSequence,
                currentModule: currentModuleName,
                moduleStatus: status,
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
