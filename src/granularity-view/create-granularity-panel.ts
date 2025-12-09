import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as Diff from 'diff'
import * as settings from '../settings/settings'
import * as openaiHelper from '../openai/openai-helper'
import { GranularityViewProvider } from './granularity-view-provider'
import { GranularityNode, GranularityRecord } from './granularity-record'
import { getSrcFileSuffix } from '../tools/lang-util'
import { cleanLLMResponse, getHumanJsonPath, LineData } from './granularity-view-utils'

export let currentRecord: GranularityRecord | null = null

const refineHighlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'), 
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextOverviewRuler'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})


// Invoked in activation function.
export function registerWebviewForGranularityPanel(context: vscode.ExtensionContext) {

    const provider = new GranularityViewProvider(context.extensionUri)

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('GranularityView', provider)
    )

    // Register webview commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.switchGranularity', (payload) => {
            if (payload && typeof payload.index === 'number' && currentRecord) {
                currentRecord.switchTo(payload.index)
            }
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.globalRefine', async () => {

            assert(currentRecord, 'No usable record for granularity panel.')
            const targetRecord: GranularityRecord = currentRecord

            vscode.window.showInformationMessage('正在执行全局精化...')

            try {
                const rootPath = targetRecord.getRootPath()
                const lastNode = targetRecord.getLastNode()
                const targetFilePath = lastNode.filePath
                const fileContent = fs.readFileSync(targetFilePath, 'utf8')

                // 获取项目根路径并构建通用数据结构路径
                const projectRootPath = targetRecord.projectHandler.rootPath
                const commonDSPath = path.join(projectRootPath, 'common_data_structures.json')

                const prompt = await openaiHelper.getGlobalRefinePrompt(fileContent, rootPath, commonDSPath)
                
                // It will take long here, where currentRecord may change.
                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)

                const timestamp = Date.now()
                const generatedFilePath = path.join(rootPath, `pseudotrans_global_refined_${timestamp}.txt`)
            
                fs.writeFileSync(generatedFilePath, result, 'utf8')
                targetRecord.appendNode(generatedFilePath, '粒度 ' + lastNode.index, false)

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
            const selection = editor?.selection
            const lastNode = targetRecord.getLastNode()
            const targetFilePath = lastNode.filePath

            if (!editor || path.relative(targetFilePath, editor.document.fileName) !== '' || !selection || selection.isEmpty) {
                vscode.window.showWarningMessage('局部精化前，请先打开模块最新粒度的文件并选中要精化的部分。')
                return
            }

            vscode.window.showInformationMessage('正在执行局部精化...')

            try {
                const rootPath = targetRecord.getRootPath()
                const sourceJsonPath = getHumanJsonPath(editor.document.fileName)
                const fileContent = editor.document.getText()
                const selectedCode = editor.document.getText(selection)
                // 注意：VS Code 的 line 是从 0 开始的，这里 +1 可能是为了 Prompt 显示
                const startLine = selection.start.line + 1 
                const endLine = selection.end.line + 1

                const prompt = await openaiHelper.getLocalRefinePrompt(fileContent, startLine, endLine, selectedCode, rootPath)
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

                targetRecord.appendNode(generatedFilePath, '粒度 ' + lastNode.index, false, highlightRanges)
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
				vscode.window.showWarningMessage('您还没有选择要回退到的粒度。')
				return
			}

			currentRecord.backTo(currentIndex, false)
			vscode.window.showInformationMessage(`当前模块已回退至粒度 ${currentIndex}。`)

            const aiPath = settings.getAiPath()
            const rootPath = currentRecord.getRootPath()
                
            try {
                const relativePath = path.relative(aiPath, rootPath)
                const currentModuleName = relativePath.split(path.sep).join('.')
                const sequence = currentRecord.projectHandler.getLeafModuleSequence()
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

                // Synchronize seq.json file.
                currentRecord.projectHandler.setOnGoingModule(seqIndex)
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
            const fileSuffix = getSrcFileSuffix(language) || '.txt'

			vscode.window.showInformationMessage(`正在生成 ${language} 代码...`)

			try {
                const rootPath = targetRecord.getRootPath()
                const lastNode = targetRecord.getLastNode()
				const fileContent = fs.readFileSync(lastNode.filePath, 'utf8')
				const prompt = await openaiHelper.getGenerateCodePrompt(fileContent, lastNode.description, language, rootPath)
				const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
				const generatedCode = cleanLLMResponse(result)
				const timestamp = Date.now();
				const generatedFilePath = path.join(rootPath, `generated_${timestamp}${fileSuffix}`)

				fs.writeFileSync(generatedFilePath, generatedCode, 'utf8')

                targetRecord.appendNode(generatedFilePath, '粒度 ' + lastNode.index, false)

                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One })

				vscode.window.showInformationMessage(`代码已生成，文件已保存: ${path.basename(generatedFilePath)}`)

                // Synchronize seq.json file.
                const relativePath = path.relative(settings.getAiPath(), rootPath)
                const currentModuleName = relativePath.split(path.sep).join('.')
                const sequence = targetRecord.projectHandler.getLeafModuleSequence()
                const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName)
                targetRecord.projectHandler.setOnGoingModule(seqIndex + 1)
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

        // Inform the webview to update UI.
        assert(currentRecord, 'No usable record for granularity panel.')
        const sequence = currentRecord.projectHandler.getLeafModuleSequence()
        const currentModuleName = path.relative(settings.getAiPath(), rootPath).split(path.sep).join('.')

        // 得到要打开模块的状态：completed / ongoing / pending
        const targetMod = sequence.find(mod => mod.relativePath === currentModuleName)      
        assert(targetMod, `无法在模块列表中找到模块: ${path.basename(rootPath)}`)
        const status = targetMod.status

        GranularityViewProvider.postMessage({
            type: 'updateView', 
            data: {
                nodes: nodes,
                moduleSequence: sequence.map(mod => mod.relativePath),
                currentModule: currentModuleName,
                moduleStatus: status
            }
        })

        // Open content for the active node if it exists.
        const activeNode = nodes.find(n => n.isActive)
        if (activeNode && activeNode.filePath) {
            try {
                const doc = await vscode.workspace.openTextDocument(activeNode.filePath)
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One
                })

                const rangesToDecorate: vscode.Range[] = [];
                if (activeNode.highlightRanges && activeNode.highlightRanges.length > 0) {
                    // 处理多段高亮
                    activeNode.highlightRanges.forEach(r => {
                        const startPos = doc.positionAt(r.start);
                        const endPos = doc.positionAt(r.end);
                        rangesToDecorate.push(new vscode.Range(startPos, endPos));
                    });
                    editor.setDecorations(refineHighlightType, rangesToDecorate);
                } else {
                    // 如果没有高亮信息，清除之前的装饰（防止复用 editor 时残留）
                    editor.setDecorations(refineHighlightType, [])
                }
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
