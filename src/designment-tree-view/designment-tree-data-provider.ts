import * as vscode from 'vscode'
import * as path from 'path'
import { getlocalNodeTree } from './designment-tree-persistence'

export enum NodeType {
    Project,
    Module,
    Requirement,
    DataStructure
}

export abstract class DesignmentTreeNode {
    constructor(
        public label: string,
        public absolutePath: string,
        public type: NodeType,
        public parent?: DirectoryNode,
    ) {}

    abstract getContentFilePath(): string
    abstract isRefinable(): boolean
    abstract isDividable(): boolean
    abstract isExtendable(): boolean
    abstract isLeaf(): boolean
    abstract hasChildren(): this is DirectoryNode

    public getTypeString(): string {
        return NodeType[this.type]
    }
}

export class FileNode extends DesignmentTreeNode {
    constructor(
        label: string,
        absolutePath: string,
        type: NodeType.Requirement | NodeType.DataStructure,
        parent?: DirectoryNode,
    ) {
        super(label, absolutePath, type, parent)
    }   

    getContentFilePath(): string {
        return this.absolutePath
    }

    isRefinable(): boolean {
        return false
    }

    isDividable(): boolean {
        return false
    }

    isExtendable(): boolean {
        return false
    }

    isLeaf(): boolean {
        return true
    }

    hasChildren(): this is DirectoryNode {
        return false
    }
}

export class DirectoryNode extends DesignmentTreeNode {
    public children: DesignmentTreeNode[]
    constructor(
        label: string,
        absolutePath: string,
        type: NodeType.Project | NodeType.Module,
        parent?: DirectoryNode,
        children?: DesignmentTreeNode[]
    ) {
        super(label, absolutePath, type, parent)
        this.children = children || []
    }

    getContentFilePath(): string {
        return path.join(this.absolutePath, 'content.txt')
    }

    isRefinable(): boolean {
        return this.type === NodeType.Module && this.children.length === 0
    }

    isDividable(): boolean {
        if (this.type === NodeType.Module) {
            return this.children.length === 0
        } else {
            return this.children.filter(child => child instanceof DirectoryNode).length === 0
        }
    }

    isExtendable(): boolean {
        return this.children.length > 0
    }

    isLeaf(): boolean {
        return this.children.length === 0
    }

    hasChildren(): this is DirectoryNode {
        return true
    }
}


// Use singleton pattern for global unique instance.
export class DesignmentTreeDataProvider implements vscode.TreeDataProvider<DesignmentTreeNode> {

    private static instance: DesignmentTreeDataProvider | null = null

    private constructor() {
        this.localNodeTree = getlocalNodeTree()
    }

    public static getInstance(): DesignmentTreeDataProvider {
        if (!this.instance) {
            this.instance = new DesignmentTreeDataProvider()
        }   
        return this.instance
    }

    // Below are normal TreeDataProvider implementations.

    private _onDidChangeTreeData = new vscode.EventEmitter<DesignmentTreeNode | DesignmentTreeNode[] | undefined | null>()
    public onDidChangeTreeData = this._onDidChangeTreeData.event

    // The actual tree structure data stored in memory.
    public localNodeTree: DesignmentTreeNode[] = []

    getTreeItem(element: DesignmentTreeNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(element.label, this.getCollapsibleState(element))
        treeItem.contextValue = this.getContextValue(element)
        treeItem.iconPath = this.getIconPath(element)
        return treeItem
    }

    private getCollapsibleState(element: DesignmentTreeNode): vscode.TreeItemCollapsibleState {
        return element.isExtendable() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    }

    private getIconPath(element: DesignmentTreeNode): vscode.ThemeIcon {
        switch (element.type) {
            case NodeType.Project:          
                return new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.white'))
            case NodeType.Module:           
                const iconName = element.isLeaf() ? 'circle' : 'type-hierarchy'
                return new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.blue'))
            case NodeType.Requirement:      
                return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.yellow'))
            case NodeType.DataStructure:    
                return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.orange'))
            default:
                throw new Error(`Unexpected node type for icon path retrieval: ${NodeType[element.type]}`)
        }
    }

    private getContextValue(element: DesignmentTreeNode): string {
        let contextValue = element.getTypeString().toLowerCase()
        if (element.isDividable()) contextValue += ' dividable'
        if (element instanceof DirectoryNode && element.type === NodeType.Project) {
            // TODO: the condition here should be modified later.
            if (element.children.find(child => child.type === NodeType.DataStructure)) {
                contextValue += ' designmentCompletable'
            } else if (!element.isDividable()) {
                contextValue += ' dataStructureAddable'
            }
        }
        return contextValue
    }

    getChildren(element?: DesignmentTreeNode): Thenable<DesignmentTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.localNodeTree)
        }

        return Promise.resolve(
            element.hasChildren() ? element.children : []
        )
    }

    // Update the view after changing node data.
    refresh(fileNode: DesignmentTreeNode | DesignmentTreeNode[] | undefined | null) {
        this._onDidChangeTreeData.fire(fileNode)
    }
}
