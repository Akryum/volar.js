import { VirtualFile, forEachEmbeddedFile, updateVirtualFileMaps } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServiceContext, Service } from '../types';
import { SourceMap } from '@volar/source-map';
import { isInsideRange, resolveCommonLanguageId, stringToSnapshot } from '../utils/common';
import { NoneCancellationToken } from '../utils/cancellation';
import { SourceMapWithDocuments } from '../documents';
import type * as ts from 'typescript/lib/tsserverlibrary';

export function register(context: ServiceContext) {

	let fakeVersion = 0;

	return async (
		uri: string,
		options: vscode.FormattingOptions,
		range: vscode.Range | undefined,
		onTypeParams: {
			ch: string,
			position: vscode.Position,
		} | undefined,
		token = NoneCancellationToken
	) => {

		let document = context.getTextDocument(uri);
		if (!document) return;

		range ??= {
			start: document.positionAt(0),
			end: document.positionAt(document.getText().length),
		};

		const source = context.documents.getSourceByUri(document.uri);
		if (!source) {
			return onTypeParams
				? (await tryFormat(document, onTypeParams.position, onTypeParams.ch))?.edits
				: (await tryFormat(document, range, undefined))?.edits;
		}

		const initialIndentLanguageId = await context.env.getConfiguration?.<Record<string, boolean>>('volar.format.initialIndent') ?? { html: true };

		let tempSourceSnapshot = source.snapshot;
		const tempVirtualFile = source.language.createVirtualFile(source.fileName, source.snapshot, source.languageId)!;
		const originalDocument = document;

		let level = 0;

		while (true) {

			const embeddedFiles = getEmbeddedFilesByLevel(tempVirtualFile, level++);
			if (embeddedFiles.length === 0)
				break;

			// if (level===2) continue;

			let edits: vscode.TextEdit[] = [];
			const toPatchIndent: {
				virtualFileName: string;
				isCodeBlock: boolean;
				service: ReturnType<Service>;
			}[] = [];

			for (const file of embeddedFiles) {

				if (!file.capabilities.documentFormatting)
					continue;

				const isCodeBlock = file.mappings.length === 1 && file.mappings[0].generatedRange[0] === 0 && file.mappings[0].generatedRange[1] === file.snapshot.getLength();
				if (onTypeParams && !isCodeBlock)
					continue;

				const docMap = createDocMap(file, source.fileName, tempSourceSnapshot);
				if (!docMap) continue;

				let embeddedCodeResult: Awaited<ReturnType<typeof tryFormat>> | undefined;

				if (onTypeParams) {

					const embeddedPosition = docMap.toGeneratedPosition(onTypeParams.position);

					if (embeddedPosition) {
						embeddedCodeResult = await tryFormat(
							docMap.virtualFileDocument,
							embeddedPosition,
							onTypeParams.ch,
						);
					}
				}
				else {
					embeddedCodeResult = await tryFormat(docMap.virtualFileDocument, {
						start: docMap.virtualFileDocument.positionAt(0),
						end: docMap.virtualFileDocument.positionAt(docMap.virtualFileDocument.getText().length),
					});
				}

				if (!embeddedCodeResult)
					continue;

				toPatchIndent.push({
					virtualFileName: file.fileName,
					isCodeBlock,
					service: embeddedCodeResult.service,
				});

				for (const textEdit of embeddedCodeResult.edits) {
					const range = docMap.toSourceRange(textEdit.range);
					if (range) {
						edits.push({
							newText: textEdit.newText,
							range,
						});
					}
				}
			}

			edits = edits.filter(edit => isInsideRange(range!, edit.range));

			if (edits.length > 0) {
				const newText = TextDocument.applyEdits(document, edits);
				document = TextDocument.create(document.uri, document.languageId, document.version + 1, newText);
				tempSourceSnapshot = stringToSnapshot(newText);
				source.language.updateVirtualFile(tempVirtualFile, tempSourceSnapshot);
			}

			if (level > 1) {

				const baseIndent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
				const editLines = new Set<number>();

				if (onTypeParams) {
					for (const edit of edits) {
						for (let line = edit.range.start.line; line <= edit.range.end.line; line++) {
							editLines.add(line);
						}
					}
				}

				for (const item of toPatchIndent) {

					let virtualFile!: VirtualFile;
					forEachEmbeddedFile(tempVirtualFile, file => {
						if (file.fileName === item.virtualFileName) {
							virtualFile = file;
						}
					});
					const docMap = createDocMap(virtualFile, source.fileName, tempSourceSnapshot);
					if (!docMap) continue;

					const indentSensitiveLines = new Set<number>();

					for (const service of item.service.provideFormattingIndentSensitiveLines ? [item.service] : Object.values(context.services)) {

						if (token.isCancellationRequested)
							break;

						if (service.provideFormattingIndentSensitiveLines) {
							const lines = await service.provideFormattingIndentSensitiveLines(docMap.virtualFileDocument, token);
							if (lines) {
								for (const line of lines) {
									const sourceLine = docMap.toSourcePosition({ line: line, character: 0 })?.line;
									if (sourceLine !== undefined) {
										indentSensitiveLines.add(sourceLine);
									}
								}
							}
						}
					}

					let indentEdits = patchIndents(
						document,
						item.isCodeBlock,
						docMap.map,
						initialIndentLanguageId[docMap.virtualFileDocument.languageId] ? baseIndent : '',
					);

					indentEdits = indentEdits.filter(edit => {
						for (let line = edit.range.start.line; line <= edit.range.end.line; line++) {
							if (indentSensitiveLines.has(line) && !edit.newText.includes('\n')) {
								return false;
							}
							if (onTypeParams && !editLines.has(line)) {
								return false;
							}
							if (!isInsideRange(range!, edit.range)) {
								return false;
							}
						}
						return true;
					});

					if (indentEdits.length > 0) {
						const newText = TextDocument.applyEdits(document, indentEdits);
						document = TextDocument.create(document.uri, document.languageId, document.version + 1, newText);
						tempSourceSnapshot = stringToSnapshot(newText);
						source.language.updateVirtualFile(tempVirtualFile, tempSourceSnapshot);
					}
				}
			}
		}

		if (document.getText() === originalDocument.getText())
			return;

		const editRange: vscode.Range = {
			start: originalDocument.positionAt(0),
			end: originalDocument.positionAt(originalDocument.getText().length),
		};
		const textEdit: vscode.TextEdit = {
			range: editRange,
			newText: document.getText(),
		};

		return [textEdit];

		function getEmbeddedFilesByLevel(rootFile: VirtualFile, level: number) {

			const embeddedFilesByLevel: VirtualFile[][] = [[rootFile]];

			while (true) {

				if (embeddedFilesByLevel.length > level)
					return embeddedFilesByLevel[level];

				let nextLevel: VirtualFile[] = [];

				for (const file of embeddedFilesByLevel[embeddedFilesByLevel.length - 1]) {
					nextLevel = nextLevel.concat(file.embeddedFiles);
				}

				embeddedFilesByLevel.push(nextLevel);
			}
		}

		async function tryFormat(
			document: TextDocument,
			range: vscode.Range | vscode.Position,
			ch?: string,
		) {

			let formatRange = range;

			for (const service of Object.values(context.services)) {

				if (token.isCancellationRequested)
					break;

				let edits: vscode.TextEdit[] | null | undefined;

				try {
					if (ch !== undefined && 'line' in formatRange && 'character' in formatRange) {
						if (service.autoFormatTriggerCharacters?.includes(ch)) {
							edits = await service.provideOnTypeFormattingEdits?.(document, formatRange, ch, options, token);
						}
					}
					else if (ch === undefined && 'start' in formatRange && 'end' in formatRange) {
						edits = await service.provideDocumentFormattingEdits?.(document, formatRange, options, token);
					}
				}
				catch (err) {
					console.warn(err);
				}

				if (!edits)
					continue;

				return {
					service,
					edits,
				};
			}
		}
	};

	function createDocMap(file: VirtualFile, _sourceFileName: string, _sourceSnapshot: ts.IScriptSnapshot) {
		const maps = updateVirtualFileMaps(file, (sourceFileName) => {
			if (!sourceFileName) {
				return [_sourceFileName, _sourceSnapshot];
			}
		});
		if (maps.has(_sourceFileName) && maps.get(_sourceFileName)![0] === _sourceSnapshot) {
			const [_, map] = maps.get(_sourceFileName)!;
			const version = fakeVersion++;
			return new SourceMapWithDocuments(
				TextDocument.create(context.env.fileNameToUri(_sourceFileName), context.host.getLanguageId?.(_sourceFileName) ?? resolveCommonLanguageId(context.env.fileNameToUri(_sourceFileName)), version, _sourceSnapshot.getText(0, _sourceSnapshot.getLength())),
				TextDocument.create(context.env.fileNameToUri(file.fileName), context.host.getLanguageId?.(file.fileName) ?? resolveCommonLanguageId(context.env.fileNameToUri(file.fileName)), version, file.snapshot.getText(0, file.snapshot.getLength())),
				map,
			);
		}
	}
}

function patchIndents(document: TextDocument, isCodeBlock: boolean, map: SourceMap, initialIndent: string) {

	const indentTextEdits: vscode.TextEdit[] = [];

	if (!isCodeBlock) {
		initialIndent = '';
	}

	for (let i = 0; i < map.mappings.length; i++) {

		const mapping = map.mappings[i];
		const firstLineIndent = getBaseIndent(mapping.sourceRange[0]);
		const text = document.getText().substring(mapping.sourceRange[0], mapping.sourceRange[1]);
		const lines = text.split('\n');
		const baseIndent = firstLineIndent + initialIndent;
		let lineOffset = lines[0].length + 1;
		let insertedFinalNewLine = false;

		if (!text.trim())
			continue;

		if (isCodeBlock && text.trimStart().length === text.length) {
			indentTextEdits.push({
				newText: '\n' + baseIndent,
				range: {
					start: document.positionAt(mapping.sourceRange[0]),
					end: document.positionAt(mapping.sourceRange[0]),
				},
			});
		}

		if (isCodeBlock && text.trimEnd().length === text.length) {
			indentTextEdits.push({
				newText: '\n',
				range: {
					start: document.positionAt(mapping.sourceRange[1]),
					end: document.positionAt(mapping.sourceRange[1]),
				},
			});
			insertedFinalNewLine = true;
		}

		if (baseIndent && lines.length > 1) {
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].trim() || i === lines.length - 1) {
					const isLastLine = i === lines.length - 1 && !insertedFinalNewLine;
					indentTextEdits.push({
						newText: isLastLine ? firstLineIndent : baseIndent,
						range: {
							start: document.positionAt(mapping.sourceRange[0] + lineOffset),
							end: document.positionAt(mapping.sourceRange[0] + lineOffset),
						},
					});
				}
				lineOffset += lines[i].length + 1;
			}
		}
	}

	return indentTextEdits;

	function getBaseIndent(pos: number) {
		const startPos = document.positionAt(pos);
		const startLineText = document.getText({ start: { line: startPos.line, character: 0 }, end: startPos });
		return startLineText.substring(0, startLineText.length - startLineText.trimStart().length);
	}
}
