import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as Diff from 'diff'
import * as openaiHelper from '../openai/openai-helper'
import { GranularityNode, GranularityRecord } from './granularity-record'
import { getSrcFileSuffix } from '../tools/lang-util'
import * as settings from '../settings/settings'

export let currentRecord: GranularityRecord | null = null

const refineHighlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'), 
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextOverviewRuler'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});

class GranularityViewProvider implements vscode.WebviewViewProvider {
    public static currentView: vscode.WebviewView | undefined
    private readonly _extensionUri: vscode.Uri

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): Thenable<void> | void {

        GranularityViewProvider.currentView = webviewView
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        }

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'executeCommand':
                    if (data.commandId === 'refinement.switchModule') {
                        const moduleName = data.payload.moduleName;
                        const aiPath = settings.getAiPath();
                        
                        if (moduleName) {
                            const modulePath = path.join(aiPath, moduleName.replace(/\./g, path.sep));
                            const moduleContentPath = path.join(modulePath, 'content.txt');
                            if (fs.existsSync(moduleContentPath)) {
                                try {

                                    const doc = await vscode.workspace.openTextDocument(moduleContentPath);
                                    await vscode.window.showTextDocument(doc);
                                    openGranularityWebview(modulePath);
                                } catch (e) {
                                    vscode.window.showErrorMessage(`无法打开模块 ${moduleName}: ${e}`);
                                }
                            } else {
                                vscode.window.showWarningMessage(`未找到模块文件: ${moduleContentPath}`);
                            }
                        }
                        return;
                    }

                    vscode.commands.executeCommand(data.commandId, data.payload)
                    return

                case 'webviewReady':
                    if (currentRecord) {
                        currentRecord.fireUpdate()
                    }
            }
        })
    }

    public static postMessage(message: any) {
        if (GranularityViewProvider.currentView) {
            GranularityViewProvider.currentView.webview.postMessage(message)
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {

        const styleUri = vscode.Uri.joinPath(
            this._extensionUri,
            'html',
            'granularity-panel.css'
        )
        
        const htmlUri = vscode.Uri.joinPath(
            this._extensionUri,
            'html',
            'granularity-panel.html'
        )

        let html = fs.readFileSync(htmlUri.fsPath, 'utf8')
        const webviewUri = webview.asWebviewUri(styleUri)
        return html.replace('{{styleUri}}', webviewUri.toString())
    }
}

// 增加一个辅助函数，用于处理后台更新
function updateRecordInBackground(
    rootPath: string,
    filePath: string,
    highlightRanges?: { start: number, end: number }[]
) {
    const tempRecord = new GranularityRecord(rootPath);
    const index = tempRecord.getCurrentIndex();
    tempRecord.addRecord(filePath, '粒度'+(index+1), false, highlightRanges);
    tempRecord.dispose();
}   

function isCurrentRecordTarget(targetDir: string): boolean {
    if (!currentRecord) return false;
    return path.relative(currentRecord.getRootPath(), targetDir) === '';
}


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
        vscode.commands.registerCommand('refinement.globalRefine', async (payload) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('请打开一个文件夹进行全局精化')
                return
            }

            const targetDir = path.dirname(editor.document.fileName);

            vscode.window.showInformationMessage('正在执行全局精化...')

            try {
                const fileContent = editor.document.getText()
                const prompt = await openaiHelper.getGlobalRefinePrompt(fileContent, targetDir)
                
                // 这里会耗时很久，期间 currentRecord 可能会变
                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
                
                const refinedContent = result
                const timestamp = Date.now()
                
                // 使用之前捕获的 targetDir，而不是重新获取 editor.document (因为 editor 可能也切走了)
                const refinedFilePath = path.join(targetDir, `pseudotrans_global_refined_${timestamp}.txt`)
            
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true })
                }

                fs.writeFileSync(refinedFilePath, refinedContent, 'utf8')

                if (currentRecord && isCurrentRecordTarget(targetDir)) {
                    const index=currentRecord.getCurrentIndex();
                    currentRecord.addRecord(refinedFilePath, '粒度'+(index+1));
                } else {
                    updateRecordInBackground(targetDir, refinedFilePath);
                    console.log(`后台更新了 ${targetDir} 的粒度记录`);
                }

                vscode.window.showInformationMessage(`全局精化完成，文件已保存: ${path.basename(refinedFilePath)}`)
            } catch (err) {
				vscode.window.showErrorMessage(`全局精化失败: ${err}`);
			}
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('refinement.localRefine', async (payload) => {
            const editor = vscode.window.activeTextEditor
            if (!editor) {
                vscode.window.showWarningMessage('请打开一个文件进行局部精化')
                return
            }

            const selection = editor.selection
            if (selection.isEmpty) {
                vscode.window.showWarningMessage('请先选中要精化的代码')
                return
            }

            const targetDir = path.dirname(editor.document.fileName);
            const sourceJsonPath = getHumanJsonPath(editor.document.fileName);

            vscode.window.showInformationMessage('正在执行局部精化...')

            try {
                const fileContent = editor.document.getText()
                const selectedCode = editor.document.getText(selection)
                // 注意：VS Code 的 line 是从 0 开始的，这里 +1 可能是为了 Prompt 显示
                const startLine = selection.start.line + 1 
                const endLine = selection.end.line + 1

                const prompt = await openaiHelper.getLocalRefinePrompt(fileContent, startLine, endLine, selectedCode, targetDir)

                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
                const refinedContent = cleanLLMResponse(result)

                const timestamp = Date.now()
                const refinedFilePath = path.join(targetDir, `pseudotrans_local_refined_${timestamp}.txt`) // 或者 .pseudo
                
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true })
                }

                let oldStatus: LineData[] = [];
                if (fs.existsSync(sourceJsonPath)) {
                    try {
                        oldStatus = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf-8'));
                    } catch (e) {
                        console.error('读取源文件状态失败', e);
                    }
                }

                const changes = Diff.diffLines(fileContent, refinedContent);

                const highlightRanges: { start: number, end: number }[] = [];
                let newStatus: LineData[] = [];

                let currentOffset = 0; // 追踪新文件 (refinedContent) 的字符偏移量
                let oldLineIndex = 0; // 追踪旧文件当前处理到的行号

                changes.forEach(part => {
                    // part.count 通常就是行数，但为了保险起见，如果 diff 库行为不一致，也可以用 split 计算
                    // 只要文件不是特别巨大，split 开销可忽略
                    // 这里直接用 part.count (diff 库标准属性)
                    const lineCount = part.count || 0; 
                    const textLength = part.value.length;

                    if (part.added) {
                        highlightRanges.push({
                            start: currentOffset,
                            end: currentOffset + textLength
                        });

                        for (let i = 0; i < lineCount; i++) {
                            newStatus.push({ type: 0, content: '' });
                        }

                        currentOffset += textLength;

                    } else if (part.removed) {
                        oldLineIndex += lineCount;
                        
                    } else {
                        for (let i = 0; i < lineCount; i++) {
                            if (oldLineIndex < oldStatus.length) {
                                newStatus.push({ 
                                    type: oldStatus[oldLineIndex].type, 
                                    content: '' 
                                });
                            } else {
                                newStatus.push({ type: 0, content: '' });
                            }
                            oldLineIndex++;
                        }

                        currentOffset += textLength;
                    }
                });
                
                const refinedLines = refinedContent.split(/\r?\n/);
                if (refinedContent.endsWith('\n') && refinedLines.length > newStatus.length) {
                    refinedLines.pop();
                }

                newStatus.forEach((status, index) => {
                    if (index < refinedLines.length) {
                        status.content = refinedLines[index];
                    }
                });

                const newJsonPath = getHumanJsonPath(refinedFilePath);

                fs.writeFileSync(newJsonPath, JSON.stringify(newStatus, null, 2), 'utf-8');
                fs.writeFileSync(refinedFilePath, refinedContent, 'utf8')

                if (currentRecord && isCurrentRecordTarget(targetDir)) {
                    const index=currentRecord.getCurrentIndex();
                    currentRecord.addRecord(refinedFilePath, '粒度'+(index+1),true,highlightRanges);
                } else {
                    updateRecordInBackground(targetDir, refinedFilePath,highlightRanges);
                    console.log(`后台更新了 ${targetDir} 的粒度记录`);
                }
                vscode.window.showInformationMessage(`局部精化完成，文件已保存: ${path.basename(refinedFilePath)}`)
            } catch (err) {
                vscode.window.showErrorMessage(`局部精化失败: ${err}`)
            }
        })
    )

    context.subscriptions.push(
		vscode.commands.registerCommand('refinement.rollback', async () => {
            
            assert(currentRecord, '当前没有活动的粒度记录，无法回退。')

            const currentIndex = currentRecord.getCurrentIndex()

			if (currentIndex < 0) {
				vscode.window.showWarningMessage('您还没有选择要回退到的粒度。')
				return
			}

			currentRecord.backTo(currentIndex)
			vscode.window.showInformationMessage(`当前模块已回退至粒度 ${currentIndex}。`)

            const aiPath = settings.getAiPath()
            const rootPath = currentRecord.getRootPath()
                
            try {
                const relativePath = path.relative(aiPath, rootPath)
                const currentModuleName = relativePath.split(path.sep).join('.')
                const sequence = currentRecord.projectHandler.getLeafModuleSequence()
                const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName)

                if (seqIndex !== -1 && seqIndex < sequence.length - 1) {
                            
                    const laterModules = sequence.slice(seqIndex + 1)
                            
                    for (const moduleName of laterModules) {

                        const moduleFullPath = path.join(aiPath, moduleName.relativePath.split('.').join(path.sep))
                        const tempRecord = new GranularityRecord(moduleFullPath);
                                        
                        tempRecord.backTo(0);
                        tempRecord.dispose();
                    }
                }

                // Synchronize seq.json file.
                // Needs refactoring.
                currentRecord.projectHandler.setOnGoingModule(seqIndex)
                currentRecord.fireUpdate()

            } catch (error) {
                console.error('级联重置失败:', error)
            }
		})
	)
    
    context.subscriptions.push(
		vscode.commands.registerCommand('refinement.generateCode', async (payload) => {

            assert(currentRecord, '当前没有活动的粒度记录，无法生成代码。');

			const editor = vscode.window.activeTextEditor
			if (!editor) {
				vscode.window.showWarningMessage('请打开一个文件进行代码生成')
				return
			}

            const targetDir = path.dirname(editor.document.fileName);
            const language = payload && payload.language ? payload.language : 'python';
            const fileSuffix = getSrcFileSuffix(language) || '.txt';

			vscode.window.showInformationMessage(`正在生成 ${language} 代码，请稍候...`)

			try {
				const fileContent = editor.document.getText()
				const currentNode = currentRecord.getCurrentNode()
				const lastGranularity = currentNode ? currentNode.description : '';
				const prompt = await openaiHelper.getGenerateCodePrompt(fileContent, lastGranularity, language, targetDir);
				const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
				const generatedCode = cleanLLMResponse(result);
				const timestamp = Date.now();
				const generatedFilePath = path.join(targetDir, `generated_${timestamp}${fileSuffix}`)

				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true })
				}
				fs.writeFileSync(generatedFilePath, generatedCode, 'utf8')

				if (isCurrentRecordTarget(targetDir)) {
                    const index = currentRecord.getCurrentIndex();
                    currentRecord.addRecord(generatedFilePath, '粒度'+(index+1));
                } else {
                    
                    updateRecordInBackground(targetDir, generatedFilePath );
                    console.log(`后台更新了 ${targetDir} 的粒度记录`);
                }

                const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

				vscode.window.showInformationMessage(`代码已生成，文件已保存: ${path.basename(generatedFilePath)}`);

                // Synchronize seq.json file.
                // Get index of current module.
                // Needs refactoring.
                const rootPath = currentRecord.getRootPath();
                const relativePath = path.relative(settings.getAiPath(), rootPath);
                const currentModuleName = relativePath.split(path.sep).join('.');
                const sequence = currentRecord.projectHandler.getLeafModuleSequence();
                const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName);
                currentRecord.projectHandler.setOnGoingModule(seqIndex + 1);
                currentRecord.fireUpdate();

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
        assert(currentRecord, '当前没有活动的粒度记录，无法更新视图。');
        const sequence = currentRecord.projectHandler.getLeafModuleSequence();
        const aiPath = settings.getAiPath();
        const modName = path.basename(rootPath);
        const relativePath = path.relative(aiPath, rootPath);
        const currentModuleName = relativePath.split(path.sep).join('.');

        // 得到要打开模块的状态：completed / ongoing / pending
        const targetMod = sequence.find(mod => mod.relativePath === currentModuleName);        
        assert(targetMod, `无法在模块列表中找到模块: ${modName}`);
        const status = targetMod.status;

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


function cleanLLMResponse(text: string): string {
    const startMarker = '```';
    const firstIndex = text.indexOf(startMarker);
    
    if (firstIndex === -1) {
        return text.trim();
    }
    
    // Find the end of the line containing the opening ```
    const nextNewline = text.indexOf('\n', firstIndex);
    let contentStartIndex = 0;
    
    if (nextNewline !== -1) {
        contentStartIndex = nextNewline + 1;
    } else {
        // Fallback if no newline found (unlikely for valid code blocks)
        contentStartIndex = firstIndex + startMarker.length;
    }
    
    let content = text.substring(contentStartIndex);
    
    // Find the closing ```
    const closingIndex = content.indexOf(startMarker);
    if (closingIndex !== -1) {
        content = content.substring(0, closingIndex);
    }
    
    return content.trim();
}


function getHumanJsonPath(fileName: string): string {
    if (fileName.endsWith('.pseudo')) {
        return fileName.replace(/\.pseudo$/, '_pseudo_human.json');
    } else {
        return fileName.replace(/\.[^.]+$/, '_py_human.json');
    }
}

interface LineData {
    type: number; // 0: AI, 1: Human
    content: string;
}
