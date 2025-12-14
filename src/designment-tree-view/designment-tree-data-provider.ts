import assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { buildTreeFromSerializedForm, persistenceTreeNode, persistTree } from './designment-tree-persistence'

export enum NodeType {
    Project,
    Module,
    Requirement,
    DataStructure
}

// It's only for designment stage for now.
export enum ProjectState {
    empty,
    dataStructureExtractable,
    designmentCompletable,
    designmentCompleted
}

export abstract class DesignmentTreeNode {
    constructor(
        public label: string,
        public absolutePath: string,
        public type: NodeType,
        public parent?: DirectoryNode,
    ) {}

    abstract getContentFilePath(): string | undefined
    abstract isRefinable(): boolean
    abstract isExtendable(): boolean
    abstract isLeaf(): boolean
    // Get the object form of this node for serialization, which can be directly used to construct the same node.
    abstract getObject(): persistenceTreeNode

    getTypeString(): string {
        return NodeType[this.type]
    }

    getProjectState(): ProjectState {
        let iter: DesignmentTreeNode = this
        while (iter.parent) iter = iter.parent
        if (iter.type === NodeType.Project && iter instanceof DirectoryNode) {
            const leafModuleJsonPath = path.join(iter.absolutePath, 'leaf_modules.json')
            if (fs.existsSync(leafModuleJsonPath))                                                   return ProjectState.designmentCompleted
            else if (iter.children.find(child => child.type === NodeType.DataStructure))             return ProjectState.designmentCompletable
            else if (iter.children.filter(child => child instanceof DirectoryNode).length === 0)     return ProjectState.empty
            else return ProjectState.dataStructureExtractable
        } else {
            throw Error('Unexpected error: root node is not of project type.')
        }
    }

    switchBannedProjectState(): DirectoryNode {
        let iter: DesignmentTreeNode = this
        while (iter.parent) iter = iter.parent
        if (iter.type === NodeType.Project && iter instanceof DirectoryNode) {
            // Switch banned state for all directory nodes under this project.
            function switchBannedState(node: DirectoryNode): void {
                node.banned = !node.banned
                node.children.forEach(child => {
                    if (child instanceof DirectoryNode) {
                        switchBannedState(child)
                    }
                }) 
            }

            switchBannedState(iter)
            return iter
        } else {
            throw Error('Unexpected error: root node is not of project type.')
        }
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

    isExtendable(): boolean {
        return false
    }

    isLeaf(): boolean {
        return true
    }

    getObject(): persistenceTreeNode {
        return {
            label: this.label,
            absolutePath: this.absolutePath,
            type: this.getTypeString(),
            childrenCount: 0,
        }
    }
}

export class DirectoryNode extends DesignmentTreeNode {
    public children: DesignmentTreeNode[]
    public banned: boolean = false
    public contentFilePath?: string
    constructor(
        label: string,
        absolutePath: string,
        type: NodeType.Project | NodeType.Module,
        parent?: DirectoryNode,
        contentFilePath?: string,
        children?: DesignmentTreeNode[],
        banned?: boolean
    ) {
        super(label, absolutePath, type, parent)
        this.children = children || []
        this.banned = banned || false
        this.contentFilePath = contentFilePath
    }
    
    getContentFilePath(): string | undefined {
        return this.contentFilePath
    }

    isRefinable(): boolean {
        return this.type === NodeType.Module && this.children.length === 0 && this.getProjectState() === ProjectState.designmentCompleted
    }

    isExtendable(): boolean {
        return this.children.length > 0
    }

    isLeaf(): boolean {
        return this.children.length === 0
    }

    getObject(): persistenceTreeNode {
        return {
            label: this.label,
            absolutePath: this.absolutePath,
            type: this.getTypeString(),
            childrenCount: this.children.length,
            contentFilePath: this.contentFilePath
        }
    }

    // When the node is selected, whether the module creating button should be activated.
    allowModuleDivisionButtonWhenSelected(): boolean {
        const projectState = this.getProjectState()
        return (projectState === ProjectState.empty || projectState === ProjectState.dataStructureExtractable) && !this.banned
    }
}


// Use singleton pattern for global unique instance.
export class DesignmentTreeDataProvider implements vscode.TreeDataProvider<DesignmentTreeNode> {

    private static instance: DesignmentTreeDataProvider | null = null

    private constructor() {
        this.localNodeTree = buildTreeFromSerializedForm()
    }

    static getInstance(): DesignmentTreeDataProvider {
        if (!this.instance) {
            this.instance = new DesignmentTreeDataProvider()
        }   
        return this.instance
    }

    static hasInstance(): boolean {
        return this.instance !== null
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

        if (element instanceof DirectoryNode && element.banned) {
            // Show spinning circle.
            return new vscode.ThemeIcon('loading~spin')
        }

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

        // Only module nodes and project nodes need extra context value.
        if (element instanceof DirectoryNode) {
            if (element.banned) contextValue += ' banned'
            if (element.type === NodeType.Project) {
                assert(element instanceof DirectoryNode, 'Unexpected error: node of type Project is not a DirectoryNode.')
                const suffix = ' ' + ProjectState[element.getProjectState()]
                contextValue += suffix
            } else if (element.type === NodeType.Module) {
                if (element.isLeaf()) {
                    contextValue += ' leaf'
                }

                if (element.getProjectState() !== ProjectState.dataStructureExtractable) {
                    contextValue += ' fixed'
                }
            }
        }
        return contextValue
    }


    getChildren(element?: DesignmentTreeNode): Thenable<DesignmentTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.localNodeTree)
        }

        return Promise.resolve(
            element instanceof DirectoryNode ? element.children : []
        )
    }

    // Update the view after changing node data.
    refresh(fileNode: DesignmentTreeNode | DesignmentTreeNode[] | undefined | null): void {
        this._onDidChangeTreeData.fire(fileNode)
    }

    
    // Invoked when the extension is activated
    dispose() {
        persistTree(this.localNodeTree)
    }

    // Banned the whole project that the given node is in.
    switchBannedStateForWholeProject(node: DesignmentTreeNode): void {
        const projectNode = node.switchBannedProjectState()
        this.refresh(projectNode)
    }
}
