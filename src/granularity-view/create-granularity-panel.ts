import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as openaiHelper from '../openai/openai-helper'
import { GranularityNode, GranularityRecord } from './granularity-record'
import { getSrcFileSuffix } from '../tools/lang-util'
import { revealTreeItem, setOnGoingModule, getModuleSequence } from '../tree-view/create-tree-view'
import * as Diff from 'diff'

export let currentRecord: GranularityRecord | null = null

// [新增] 1. 定义高亮装饰器类型 
const refineHighlightType = vscode.window.createTextEditorDecorationType({
    // 背景色：自动跟随主题的“新增代码”背景色
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    
    // (可选) 边框：如果当前主题定义了插入文本的边框，也会自动应用
    borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'), 
    
    // 滚动条标记：在右侧滚动条上也显示对应的颜色
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
                        const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
                        
                        if (aiPath && moduleName) {
                            // 假设模块入口文件是 content.txt
                            const moduleContentPath = path.join(aiPath, moduleName, 'content.txt')
                            
                            if (fs.existsSync(moduleContentPath)) {
                                try {
                                    const doc = await vscode.workspace.openTextDocument(moduleContentPath)
                                    await vscode.window.showTextDocument(doc)
                                    // 打开文档会自动触发 tree-view 的 selection 监听，从而更新 webview

                                    revealTreeItem(moduleContentPath);
                                } catch (e) {
                                    vscode.window.showErrorMessage(`无法打开模块 ${moduleName}: ${e}`)
                                }
                            } else {
                                vscode.window.showWarningMessage(`未找到模块文件: ${moduleContentPath}`)
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
// 增加一个辅助函数，用于处理“后台”更新
function updateRecordInBackground(rootPath: string, filePath: string,highlightRanges?: { start: number, end: number }[]) {
    // 创建一个临时的 Record 实例，只为了读取-更新-保存 JSON
    const tempRecord = new GranularityRecord(rootPath);
    const index=tempRecord.getCurrentIndex();
    tempRecord.addRecord(filePath, '粒度'+(index+1), false, highlightRanges);
    // 调用 dispose 强制写入 node.json
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

            // 1. 【关键修改】在 await 之前，捕获当前的上下文路径
            // 这是我们这次操作的目标“根据地”
            const targetDir = path.dirname(editor.document.fileName);

            vscode.window.showInformationMessage('正在执行全局精化...')

            try {
                const fileContent = editor.document.getText()
                const prompt = openaiHelper.getGlobalRefinePrompt(fileContent)
                
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

                // 2. 【关键修改】判断 currentRecord 是否还是我们操作的那个
                // 检查 currentRecord 是否存在，且其管理的路径是否等于我们当初捕获的 targetDir
                // 注意：你需要给 GranularityRecord 加一个 getter 来获取 rootPath，或者直接访问 public 属性
                if (currentRecord && isCurrentRecordTarget(targetDir)) {
                    // 场景A：用户没切走，直接更新 UI
                    const index=currentRecord.getCurrentIndex();
                    currentRecord.addRecord(refinedFilePath, '粒度'+(index+1));
                } else {
                    // 场景B：用户切走了，我们在后台更新 node.json，不打扰前台，描述：第 index 粒度全局精化
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
            // 1. 获取源文件的 JSON 路径
            const sourceJsonPath = getHumanJsonPath(editor.document.fileName);

            vscode.window.showInformationMessage('正在执行局部精化...')

            try {
                const fileContent = editor.document.getText()
                const selectedCode = editor.document.getText(selection)
                // 注意：VS Code 的 line 是从 0 开始的，这里 +1 可能是为了 Prompt 显示
                const startLine = selection.start.line + 1 
                const endLine = selection.end.line + 1

                const prompt = openaiHelper.getLocalRefinePrompt(fileContent, startLine, endLine, selectedCode)

                const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
                const refinedContent = cleanLLMResponse(result)

                const timestamp = Date.now()
                // 新文件的路径
                const refinedFilePath = path.join(targetDir, `pseudotrans_local_refined_${timestamp}.txt`) // 或者 .pseudo
                
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true })
                }

                // --- 核心修改开始：处理状态继承 ---

                // A. 读取源文件的状态
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

                let currentOffset = 0; // 追踪新文件(refinedContent)的字符偏移量
                let oldLineIndex = 0; // 追踪旧文件当前处理到的行号

                changes.forEach(part => {
                    // part.count 通常就是行数，但为了保险起见，如果 diff 库行为不一致，也可以用 split 计算
                    // 只要文件不是特别巨大，split 开销可忽略
                    // 这里直接用 part.count (diff 库标准属性)
                    const lineCount = part.count || 0; 
                    const textLength = part.value.length;

                    if (part.added) {
                        // 【新增/修改】：对应新文件内容，需要高亮，标记为 AI (0)
                        
                        // A. 记录高亮范围 (在新文件中的位置)
                        highlightRanges.push({
                            start: currentOffset,
                            end: currentOffset + textLength
                        });

                        // B. 生成新状态 (全部设为 AI)
                        for (let i = 0; i < lineCount; i++) {
                            newStatus.push({ type: 0, content: '' });
                        }

                        // C. 推进新文件指针
                        currentOffset += textLength;

                    } else if (part.removed) {
                        // 【删除】：对应旧文件内容，新文件中不存在
                        
                        // A. 只需要跳过旧文件的状态索引
                        oldLineIndex += lineCount;
                        
                        // 不更新 currentOffset，也不推入 newStatus

                    } else {
                        // 【未变】：对应新文件内容，不需要高亮，继承旧状态
                        
                        // A. 继承状态
                        for (let i = 0; i < lineCount; i++) {
                            // 尝试从旧状态中获取
                            if (oldLineIndex < oldStatus.length) {
                                newStatus.push({ 
                                    type: oldStatus[oldLineIndex].type, 
                                    content: '' 
                                });
                            } else {
                                // 兜底：如果越界，默认 AI
                                newStatus.push({ type: 0, content: '' });
                            }
                            oldLineIndex++;
                        }

                        // B. 推进新文件指针
                        currentOffset += textLength;
                    }
                });
                
                // 3. 回填 content 内容 (为了 JSON 完整性)
                const refinedLines = refinedContent.split(/\r?\n/);
                // 处理 split 可能产生的末尾空串 (如果原文本以换行结尾)
                if (refinedContent.endsWith('\n') && refinedLines.length > newStatus.length) {
                    refinedLines.pop();
                }

                newStatus.forEach((status, index) => {
                    if (index < refinedLines.length) {
                        status.content = refinedLines[index];
                    }
                });

                // 4. 写入新 JSON
                const newJsonPath = getHumanJsonPath(refinedFilePath);

                // 2. 写入
                fs.writeFileSync(newJsonPath, JSON.stringify(newStatus, null, 2), 'utf-8');

                // --- 核心修改结束 ---

                fs.writeFileSync(refinedFilePath, refinedContent, 'utf8')

                if (currentRecord && isCurrentRecordTarget(targetDir)) {
                    // 场景A：用户没切走，直接更新 UI
                    const index=currentRecord.getCurrentIndex();
                    currentRecord.addRecord(refinedFilePath, '粒度'+(index+1),true,highlightRanges);
                } else {
                    // 场景B：用户切走了，我们在后台更新 node.json，不打扰前台
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
            
			if (currentRecord) {
                // 1. 获取当前索引
                const currentIndex = currentRecord.getCurrentIndex()

			    if (currentIndex < 0) {
				    vscode.window.showWarningMessage('您还没有选择要回退到的粒度。')
				    return
			    }

                // 2. [修改] 局部回退：回退到上一个状态 (currentIndex - 1)
                // 原有逻辑是 backTo(currentIndex)，如果是最后一个节点则没有任何效果，通常回退意味着撤销最近一步
			    currentRecord.backTo(currentIndex)
			    vscode.window.showInformationMessage(`当前模块已回退至粒度 ${currentIndex}。`)

                // 3. [新增] 级联重置：丢弃后续模块的历史
                const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
                const rootPath = currentRecord.getRootPath();
                
                if (aiPath) {
                    try {
                        // 计算当前模块的相对路径名称 (匹配 seq.json)
                        const relativePath = path.relative(aiPath, rootPath);
                        const currentModuleName = relativePath.split(path.sep).join('/');
                        
                        // 获取模块索引
                        const sequence = getModuleSequence();
                        const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName);

                        // 如果当前模块在序列中，且不是最后一个
                        if (seqIndex !== -1 && seqIndex < sequence.length - 1) {
                            
                            // 获取所有排在后面的模块
                            const laterModules = sequence.slice(seqIndex + 1);
                            
                            // 遍历并重置
                            for (const moduleName of laterModules) {
                                const moduleFullPath = path.join(aiPath, moduleName.relativePath);
                                const jsonPath = path.join(moduleFullPath, 'node.json');

                                // 只有当该模块有历史记录时才处理
                                if (fs.existsSync(jsonPath)) {
                                    try {
                                        // 实例化一个临时的 Record 管理器
                                        const tempRecord = new GranularityRecord(moduleFullPath);
                                        
                                        // 【核心操作】强制回退到索引 0 (只保留初始描述 content.txt)
                                        // 这会自动删除该模块下生成的代码、伪代码文件
                                        tempRecord.backTo(0);
                                        
                                        // 保存更改 (写入 node.json)
                                        tempRecord.dispose();
                                        
                                        console.log(`[Cascade Reset] 已重置模块: ${moduleName}`);
                                    } catch (e) {
                                        console.error(`重置模块 ${moduleName} 失败:`, e);
                                    }
                                }
                            }
                            
                            vscode.window.showInformationMessage(`已级联重置后续 ${laterModules.length} 个模块的历史。`);
                        }

                        // Synchronize seq.json file.
                        // Needs refactoring.
                        setOnGoingModule(seqIndex);
                        currentRecord.fireUpdate();

                    } catch (error) {
                        console.error('级联重置失败:', error);
                    }
                }
            }
		})
	)
    
    context.subscriptions.push(
		vscode.commands.registerCommand('refinement.generateCode', async (payload) => {
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				vscode.window.showWarningMessage('请打开一个文件进行代码生成')
				return
			}
            const targetDir = path.dirname(editor.document.fileName);

			// [新增] 获取用户选择的语言，默认为 python
            const language = payload && payload.language ? payload.language : 'python';
            // [新增] 获取对应的后缀名
            const fileSuffix = getSrcFileSuffix(language) || '.txt';

			vscode.window.showInformationMessage(`正在生成 ${language} 代码，请稍候...`)

			try {
				const fileContent = editor.document.getText()
				const currentNode = currentRecord!.getCurrentNode()
				const lastGranularity = currentNode ? currentNode.description : '';

                // [修改] 传入 language 参数
				const prompt = openaiHelper.getGenerateCodePrompt(fileContent, lastGranularity, language);
				
				const result = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
				
				const generatedCode = cleanLLMResponse(result);

				const timestamp = Date.now();
                // [修改] 使用动态后缀名
				const generatedFilePath = path.join(targetDir, `generated_${timestamp}${fileSuffix}`)

				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true })
				}
				fs.writeFileSync(generatedFilePath, generatedCode, 'utf8')

				const doc = await vscode.workspace.openTextDocument(generatedFilePath)
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });

				if (currentRecord && isCurrentRecordTarget(targetDir)) {
                    const index = currentRecord.getCurrentIndex();
                    currentRecord.addRecord(generatedFilePath, '粒度'+(index+1));
                } else {
                    
                    updateRecordInBackground(targetDir, generatedFilePath );
                    console.log(`后台更新了 ${targetDir} 的粒度记录`);
                }

				vscode.window.showInformationMessage(`代码已生成，文件已保存: ${path.basename(generatedFilePath)}`);

                // Synchronize seq.json file.
                // Get index of current module.
                // Needs refactoring.
                const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
                const rootPath = currentRecord!.getRootPath();
                const relativePath = path.relative(aiPath!, rootPath);
                const currentModuleName = relativePath.split(path.sep).join('/');
                const sequence = getModuleSequence();
                const seqIndex = sequence.findIndex(mod => mod.relativePath === currentModuleName);
                setOnGoingModule(seqIndex + 1);
                currentRecord!.fireUpdate();

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
        // [新增] 获取当前模块信息
        const sequence = getModuleSequence();
        const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
        const modName = path.basename(rootPath);
        let currentModuleName = ''
        if (aiPath) {
            // 1. 计算相对路径 (例如: from /root to /root/123/456 -> 123/456)
            const relativePath = path.relative(aiPath, rootPath);
            
            // 2. [关键] 统一路径分隔符为 '/'。
            // 即使在 Windows 上 path.relative 可能返回 '123\456'，
            // 但 seq.json 通常是 '123/456'。前端比较需要完全一致。
            currentModuleName = relativePath.split(path.sep).join('/');
        } else {
            currentModuleName = modName; // 兜底
        }

        // 得到要打开模块的状态：completed/ongoing/pending
        const targetMod = sequence.find(mod => path.basename(mod.relativePath) === modName);        
        const status = targetMod!.status;

        // [修改] 发送的数据类型改为 'updateView'，并包含更多信息
        GranularityViewProvider.postMessage({
            type: 'updateView', 
            data: {
                nodes: nodes,
                moduleSequence: sequence,
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
                if (activeNode.highlightRanges&&activeNode.highlightRanges.length>0) {
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


// --- 辅助函数：获取对应的 human json 路径 ---
function getHumanJsonPath(fileName: string): string {
    if (fileName.endsWith('.pseudo')) {
        return fileName.replace(/\.pseudo$/, '_pseudo_human.json');
    } else {
        return fileName.replace(/\.[^.]+$/, '_py_human.json');
    }
}

// --- 辅助类型定义 ---
interface LineData {
    type: number; // 0: AI, 1: Human
    content: string;
}
