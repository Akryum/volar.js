import { VirtualFiles, VirtualFile, FileRangeCapabilities, MirrorBehaviorCapabilities, MirrorMap, forEachEmbeddedFile, TypeScriptLanguageHost } from '@volar/language-core';
import { Mapping, SourceMap } from '@volar/source-map';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type * as ts from 'typescript/lib/tsserverlibrary';
import { ServiceEnvironment } from './types';
import { resolveCommonLanguageId } from './utils/common';

export type DocumentsAndSourceMaps = ReturnType<typeof createDocumentsAndSourceMaps>;

export class SourceMapWithDocuments<Data = any> {

	constructor(
		public sourceFileDocument: TextDocument,
		public virtualFileDocument: TextDocument,
		public map: SourceMap<Data>,
	) { }

	// Range APIs

	public toSourceRange(range: vscode.Range, filter: (data: Data) => boolean = () => true) {
		for (const result of this.toSourceRanges(range, filter)) {
			return result;
		}
	}

	public toGeneratedRange(range: vscode.Range, filter: (data: Data) => boolean = () => true) {
		for (const result of this.toGeneratedRanges(range, filter)) {
			return result;
		}
	}

	public * toSourceRanges(range: vscode.Range, filter: (data: Data) => boolean = () => true) {
		for (const result of this.toRanges(range, filter, 'toSourcePositionsBase', 'matchSourcePosition')) {
			yield result;
		}
	}

	public * toGeneratedRanges(range: vscode.Range, filter: (data: Data) => boolean = () => true) {
		for (const result of this.toRanges(range, filter, 'toGeneratedPositionsBase', 'matchGeneratedPosition')) {
			yield result;
		}
	}

	protected * toRanges(
		range: vscode.Range,
		filter: (data: Data) => boolean,
		api: 'toSourcePositionsBase' | 'toGeneratedPositionsBase',
		api2: 'matchSourcePosition' | 'matchGeneratedPosition'
	) {
		const failedLookUps: (readonly [vscode.Position, Mapping<Data>])[] = [];
		for (const mapped of this[api](range.start, filter, 'left')) {
			const end = this[api2](range.end, mapped[1], 'right');
			if (end) {
				yield { start: mapped[0], end } as vscode.Range;
			}
			else {
				failedLookUps.push(mapped);
			}
		}
		for (const failedLookUp of failedLookUps) {
			for (const mapped of this[api](range.end, filter, 'right')) {
				yield { start: failedLookUp[0], end: mapped[0] } as vscode.Range;
			}
		}
	}

	// Position APIs

	public toSourcePosition(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		for (const mapped of this.toSourcePositions(position, filter, baseOffset)) {
			return mapped;
		}
	}

	public toGeneratedPosition(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		for (const mapped of this.toGeneratedPositions(position, filter, baseOffset)) {
			return mapped;
		}
	}

	public * toSourcePositions(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		for (const mapped of this.toSourcePositionsBase(position, filter, baseOffset)) {
			yield mapped[0];
		}
	}

	public * toGeneratedPositions(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		for (const mapped of this.toGeneratedPositionsBase(position, filter, baseOffset)) {
			yield mapped[0];
		}
	}

	public * toSourcePositionsBase(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		let hasResult = false;
		for (const mapped of this.toPositions(position, filter, this.virtualFileDocument, this.sourceFileDocument, 'generatedRange', 'sourceRange', baseOffset ?? 'left')) {
			hasResult = true;
			yield mapped;
		}
		if (!hasResult && baseOffset === undefined) {
			for (const mapped of this.toPositions(position, filter, this.virtualFileDocument, this.sourceFileDocument, 'generatedRange', 'sourceRange', 'right')) {
				yield mapped;
			}
		}
	}

	public * toGeneratedPositionsBase(position: vscode.Position, filter: (data: Data) => boolean = () => true, baseOffset?: 'left' | 'right') {
		let hasResult = false;
		for (const mapped of this.toPositions(position, filter, this.sourceFileDocument, this.virtualFileDocument, 'sourceRange', 'generatedRange', baseOffset ?? 'left')) {
			hasResult = true;
			yield mapped;
		}
		if (!hasResult && baseOffset === undefined) {
			for (const mapped of this.toPositions(position, filter, this.sourceFileDocument, this.virtualFileDocument, 'sourceRange', 'generatedRange', 'right')) {
				yield mapped;
			}
		}
	}

	protected * toPositions(
		position: vscode.Position,
		filter: (data: Data) => boolean,
		fromDoc: TextDocument,
		toDoc: TextDocument,
		from: 'sourceRange' | 'generatedRange',
		to: 'sourceRange' | 'generatedRange',
		baseOffset: 'left' | 'right',
	) {
		for (const mapped of this.map.matching(fromDoc.offsetAt(position), from, to, baseOffset === 'right')) {
			if (!filter(mapped[1].data)) {
				continue;
			}
			yield [toDoc.positionAt(mapped[0]), mapped[1]] as const;
		}
	}

	protected matchSourcePosition(position: vscode.Position, mapping: Mapping, baseOffset: 'left' | 'right') {
		let offset = this.map.matchOffset(this.virtualFileDocument.offsetAt(position), mapping['generatedRange'], mapping['sourceRange'], baseOffset === 'right');
		if (offset !== undefined) {
			return this.sourceFileDocument.positionAt(offset);
		}
	}

	protected matchGeneratedPosition(position: vscode.Position, mapping: Mapping, baseOffset: 'left' | 'right') {
		let offset = this.map.matchOffset(this.sourceFileDocument.offsetAt(position), mapping['sourceRange'], mapping['generatedRange'], baseOffset === 'right');
		if (offset !== undefined) {
			return this.virtualFileDocument.positionAt(offset);
		}
	}
}

export class MirrorMapWithDocument extends SourceMapWithDocuments<[MirrorBehaviorCapabilities, MirrorBehaviorCapabilities]> {
	constructor(
		public document: TextDocument,
		map: MirrorMap,
	) {
		super(document, document, map);
	}
	*findMirrorPositions(start: vscode.Position) {
		for (const mapped of this.toGeneratedPositionsBase(start)) {
			yield [mapped[0], mapped[1].data[1]] as const;
		}
		for (const mapped of this.toSourcePositionsBase(start)) {
			yield [mapped[0], mapped[1].data[0]] as const;
		}
	}
}

export function createDocumentsAndSourceMaps(
	env: ServiceEnvironment,
	host: TypeScriptLanguageHost,
	mapper: VirtualFiles,
) {

	let version = 0;

	const map2DocMap = new WeakMap<SourceMap<FileRangeCapabilities>, SourceMapWithDocuments<FileRangeCapabilities>>();
	const mirrorMap2DocMirrorMap = new WeakMap<MirrorMap, MirrorMapWithDocument>();
	const snapshot2Doc = new WeakMap<ts.IScriptSnapshot, Map<string, TextDocument>>();

	return {
		getSourceByUri(sourceFileUri: string) {
			return mapper.getSource(env.uriToFileName(sourceFileUri));
		},
		isVirtualFileUri(virtualFileUri: string) {
			return mapper.hasVirtualFile(env.uriToFileName(virtualFileUri));
		},
		getVirtualFileByUri(virtualFileUri: string) {
			return mapper.getVirtualFile(env.uriToFileName(virtualFileUri));
		},
		getMirrorMapByUri(virtualFileUri: string) {
			const fileName = env.uriToFileName(virtualFileUri);
			const [virtualFile] = mapper.getVirtualFile(fileName);
			if (virtualFile) {
				const map = mapper.getMirrorMap(virtualFile);
				if (map) {
					if (!mirrorMap2DocMirrorMap.has(map)) {
						mirrorMap2DocMirrorMap.set(map, new MirrorMapWithDocument(
							getDocumentByFileName(virtualFile.snapshot, fileName),
							map,
						));
					}
					return [virtualFile, mirrorMap2DocMirrorMap.get(map)!] as const;
				}
			}
		},
		getMapsBySourceFileUri(uri: string) {
			return this.getMapsBySourceFileName(env.uriToFileName(uri));
		},
		getMapsBySourceFileName(fileName: string) {
			const source = mapper.getSource(fileName);
			if (source) {
				const result: [VirtualFile, SourceMapWithDocuments<FileRangeCapabilities>][] = [];
				forEachEmbeddedFile(source.root, (virtualFile) => {
					for (const [sourceFileName, [sourceSnapshot, map]] of mapper.getMaps(virtualFile)) {
						if (sourceSnapshot === source.snapshot) {
							if (!map2DocMap.has(map)) {
								map2DocMap.set(map, new SourceMapWithDocuments(
									getDocumentByFileName(sourceSnapshot, sourceFileName),
									getDocumentByFileName(virtualFile.snapshot, fileName),
									map,
								));
							}
							result.push([virtualFile, map2DocMap.get(map)!]);
						}
					}
				});
				return {
					snapshot: source.snapshot,
					maps: result,
				};
			}
		},
		getMapsByVirtualFileUri(virtualFileUri: string) {
			return this.getMapsByVirtualFileName(env.uriToFileName(virtualFileUri));
		},
		*getMapsByVirtualFileName(virtualFileName: string): IterableIterator<[VirtualFile, SourceMapWithDocuments<FileRangeCapabilities>]> {
			const [virtualFile] = mapper.getVirtualFile(virtualFileName);
			if (virtualFile) {
				for (const [sourceFileName, [sourceSnapshot, map]] of mapper.getMaps(virtualFile)) {
					if (!map2DocMap.has(map)) {
						map2DocMap.set(map, new SourceMapWithDocuments(
							getDocumentByFileName(sourceSnapshot, sourceFileName),
							getDocumentByFileName(virtualFile.snapshot, virtualFileName),
							map,
						));
					}
					yield [virtualFile, map2DocMap.get(map)!];
				}
			}
		},
		getDocumentByUri(snapshot: ts.IScriptSnapshot, uri: string) {
			return this.getDocumentByFileName(snapshot, env.uriToFileName(uri));
		},
		getDocumentByFileName,
	};

	function getDocumentByFileName(snapshot: ts.IScriptSnapshot, fileName: string) {
		if (!snapshot2Doc.has(snapshot)) {
			snapshot2Doc.set(snapshot, new Map());
		}
		const map = snapshot2Doc.get(snapshot)!;
		if (!map.has(fileName)) {
			const uri = env.fileNameToUri(fileName);
			map.set(fileName, TextDocument.create(
				uri,
				host.getLanguageId?.(fileName) ?? resolveCommonLanguageId(uri),
				version++,
				snapshot.getText(0, snapshot.getLength()),
			));
		}
		return map.get(fileName)!;
	}
}
