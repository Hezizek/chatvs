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
import { initialProject } from '../tools/project-initializer'
import { writeModule } from '../tools/module-writer'
import { updateRootLaunchConfig } from '../tools/launch-config-updater'
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

            const currentIndex = currentRecord.getCurrentIndex()
			if (currentIndex < 0) {
				vscode.window.showWarningMessage('您还没有选择要回退到的伪代码记录。')
				return
			}

			currentRecord.backTo(currentIndex, false)
            const currentNode = currentRecord.getCurrentNode()
            const description = currentNode ? currentNode.description : '未知伪代码'

            vscode.window.showInformationMessage(`当前模块已回退至`+description+`。`)

            const aiPath = settings.getAiPath()
            const rootPath = currentRecord.getRootPath()
            const projectHandler = currentRecord.projectHandler
                
            try {
                const relativePath = path.relative(aiPath, rootPath)
                const currentModuleName = relativePath.split(path.sep).join('.')
                const sequence = projectHandler.getLeafModuleSequence()
                const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName)

                if (seqIndex >= 0 && seqIndex < sequence.length - 1) {

                    const laterModules = sequence.slice(seqIndex + 1)
                    for (const moduleName of laterModules) {
                        const moduleFullPath = path.join(aiPath, moduleName.relativePath.split('.').join(path.sep))
                        const tempRecord = new GranularityRecord(moduleFullPath)
                                        
                        tempRecord.backTo(0, false)
                        tempRecord.dispose()
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
            const currentModuleName = relativePath.split(path.sep).join('.')
            const sequence = projectHandler.getLeafModuleSequence()
            const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName)
            const isFirstModule = (seqIndex === 0)
            const isLastModule = (seqIndex === sequence.length - 1)
            

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
        const sequence = currentRecord.projectHandler.getLeafModuleSequence()
        const currentModuleName = path.relative(settings.getAiPath(), rootPath).split(path.sep).join('.')

        // 得到要打开模块的状态：completed / ongoing / pending
        const targetMod = sequence.find(mod => mod.relativePath === currentModuleName)      
        assert(targetMod, `无法在模块列表中找到模块: ${path.basename(rootPath)}`)
        const status = targetMod.status

        // 获取当前粒度（根据活动节点的描述判断）
        const activeNode = nodes.find(n => n.isActive)
        // 粒度级别 = 节点index - 1 (因为第一个节点index=1表示粒度0)
        let currentGranularity = activeNode ? activeNode.index - 1 : -1

        GranularityViewProvider.postMessage({
            type: 'updateView', 
            data: {
                nodes: nodes,
                moduleSequence: sequence.map(mod => mod.relativePath),
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
