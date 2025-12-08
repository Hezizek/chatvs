import * as vscode from 'vscode';

export const remake = (context: vscode.ExtensionContext) => {
    let activeEditor = vscode.window.activeTextEditor;
    let decorationsArray: vscode.DecorationOptions[] = [];

    const decorationType = vscode.window.createTextEditorDecorationType({
        // backgroundColor: 'rgba(255, 215, 0, 0.3)', // 金色背景，半透明
        // borderRadius: '3px'
    });

    function removeDecorations() {
        if (activeEditor) {
            activeEditor.setDecorations(decorationType, []); // 清除当前活动编辑器的装饰
            for (let type in decorationTypes) {
                activeEditor.setDecorations(decorationTypes[type], []); // 移除不同类型的装饰
            }
        }
    }

    const decorationTypes: { [key: number]: vscode.TextEditorDecorationType } = {
        2: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.3)', // 红色背景，半透明
            borderRadius: '3px',
        }),
        4: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.3)', // 绿色背景，半透明
            borderRadius: '3px',
        }),
        3: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 0, 255, 0.3)', // 蓝色背景，半透明
            borderRadius: '3px',
        }),
        5: vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(128, 0, 128, 0.3)', // 紫色背景，半透明
            borderRadius: '3px',
        }),
    };

    const decorationRanges: { [key: number]: vscode.Range[] } = {
        2: [], // 红色
        3: [], // 绿色
        4: [], // 蓝色
        5: [], // 紫色
    };

    if (activeEditor) {
        removeDecorations();
        const document = activeEditor.document;
        initializeDecorations();
        //loadAndApplyJsonDecorations(document);
        if (activeEditor.document.fileName.endsWith('.pseudo')) {
            applyBlockDecorations(activeEditor.document);
        }
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            activeEditor = editor; // 更新当前活动的编辑器
            const document = editor.document;
            removeDecorations(); // 切换文件时，移除旧文件的装饰
            decorationsArray = []; // 切换到新文件时清空装饰数组
            initializeDecorations();
            //loadAndApplyJsonDecorations(document);
            if (activeEditor.document.fileName.endsWith('.pseudo')) {
                applyBlockDecorations(activeEditor.document);
            }
        }
    }, null, context.subscriptions);


    vscode.workspace.onDidChangeTextDocument(event => {
        if (activeEditor && event.document === activeEditor.document) {
            updateDecorations(event.document, event.contentChanges);
        }
    }, null, context.subscriptions);

    function updateDecorations(document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]) {
        if (activeEditor && document === activeEditor.document) {
            changes.forEach(change => {
                if (activeEditor) {
                    // 仅对新增或替换的文本添加样式（删除操作时 change.text 为空）
                    if (change.text.length > 0) {
                        const startPos = activeEditor.document.positionAt(change.rangeOffset);
                        const endPos = activeEditor.document.positionAt(change.rangeOffset + change.text.length);
                        const decoration = {
                            range: new vscode.Range(startPos, endPos),
                            hoverMessage: "Newly added content"
                        };
                        decorationsArray.push(decoration);
                    }
                }
            });
            applyDecorations();
        }
    }

    function initializeDecorations() {
        removeDecorations();
        applyDecorations();
    }

    function applyDecorations() {
        if (activeEditor) {
            activeEditor.setDecorations(decorationType, decorationsArray); // 只对当前活动的编辑器应用装饰
        }
    }

    function applyBlockDecorations(document: vscode.TextDocument) {
        if (!activeEditor) return;
    
        const redRanges: vscode.Range[] = [];
        const blueRanges: vscode.Range[] = [];
        let isRed = true; // 交替使用红色和蓝色
        let currentBlock: string | null = null; // 当前块标识符
        let blockStartLine: number = -1; // 当前块的起始行
    
        const blockRegex = /^block(\d+)/; // 匹配类似 block1:、block2: 的行
    
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const match = blockRegex.exec(line.text.trim());
    
            if (match) {
                // 如果匹配到 block 标识符，记录当前块的起始行
                if (currentBlock) {
                    // 如果已经在一个块中，结束上一个块的范围并交替颜色
                    const endRange = new vscode.Range(activeEditor.document.lineAt(blockStartLine).range.start, activeEditor.document.lineAt(i).range.start);
                    if (isRed) {
                        redRanges.push(endRange);
                    } else {
                        blueRanges.push(endRange);
                    }
                }
    
                // 更新当前块的标识符和起始行
                currentBlock = match[0];
                blockStartLine = i;
                isRed = !isRed; // 交替颜色
                
                // 删除该行的内容
                continue;  // 跳过该行
            }
    
            // 处理非匹配行，记录到块的范围内
            if (currentBlock) {
                // 继续处理块内的其他内容
                // 这里可以添加对非匹配行的其他处理逻辑，如记录行内容
            }
        }
    
        // 处理最后一个块
        if (currentBlock && blockStartLine !== -1) {
            const lastRange = new vscode.Range(activeEditor.document.lineAt(blockStartLine).range.start, activeEditor.document.lineAt(document.lineCount - 1).range.end);
            if (isRed) {
                redRanges.push(lastRange);
            } else {
                blueRanges.push(lastRange);
            }
        }
    
        // 应用装饰到编辑器
        activeEditor.setDecorations(decorationTypes[2], redRanges);
        activeEditor.setDecorations(decorationTypes[3], blueRanges);
    
        // 额外步骤：清空匹配行
        const edit = new vscode.WorkspaceEdit();
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            if (blockRegex.exec(line.text.trim())) {
                edit.delete(document.uri, line.range); // 删除匹配到的行
            }
        }
        vscode.workspace.applyEdit(edit); // 应用编辑
    }
};
