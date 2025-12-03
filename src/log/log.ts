import * as vscode from 'vscode';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as settings from '../settings/settings';

interface LogData {
    operation: 
        | 'addpro' 
        | 'addnode' 
        | 'deletenode' 
        | 'generatepseudo' 
        | 'regeneratepseudo' 
        | 'code' 
        | 'mergeall' 
        | 'divideblocks' 
        | 'lineconfirm'
        | 'pseudo fix'
        | 'code fix';
    target: string;
    [key: string]: any;
}

let transport: DailyRotateFile;
let logger: winston.Logger;

export async function startLogging(context : vscode.ExtensionContext) {
    transport = new DailyRotateFile({
        dirname: context.globalStorageUri.fsPath,
        filename: '%DATE%-codesketcher.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '100k',
        maxFiles: '10',
        zippedArchive: true,
        level: 'info',
    });

    logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.printf(info => 
                JSON.stringify({ ...(info.message as object), timestamp: info.timestamp })
            )
        ),
        transports: [transport]
    });
}

/**
 * 该函数用于记录用户在执行关键操作时的日志信息，包括操作类型和操作目标路径。
 * 
 * @param {LogData} data          - 需要记录的日志数据对象
 * @param {string} data.operation - 用户操作类型，必须是预定义的操作类型之一：
 *   - 'addpro':           新建项目（根节点）
 *   - 'addnode':          增加节点
 *   - 'deletenode':       删除节点
 *   - 'generatepseudo':   划分节点，生成伪代码
 *   - 'regeneratepseudo': 重新生成伪代码
 *   - 'code':             生成具体代码
 *   - 'mergeall':         合并代码块
 *   - 'divideblocks':     分割代码块
 *   - 'lineconfirm':      行确认操作
 *   - 'pseudo fix':       修改伪代码保存操作
 *   - 'code fix':         修改具体代码保存操作
 * @param {string} data.target    - 目标节点的绝对路径
 * @param {Object} [data.additionalFields] - 可选的额外日志字段
 */
export async function logInfo(data: LogData) {
    let treeRoot = settings.getAiPath();
    data.target = data.target
        .substring(treeRoot.length + 1)
        .replace(/\\/g, '.');
    logger.info(data);
}

