'use strict';

import { code2String, fixWithRules, LintOut, Rule, lint, makeSeverity } from 'devreplay';
import * as path from 'path';
import * as fs from 'fs';

import {
	CodeAction,
	CodeActionKind,
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	InitializeParams,
	Range,
	TextDocumentEdit,
	TextDocuments,
	TextDocumentSyncKind,
	TextEdit,
	WorkspaceFolder,
	WorkspaceEdit,
	VersionedTextDocumentIdentifier,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection();
connection.console.info(`DevReplay server running in node ${process.version}`);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
documents.listen(connection);

let workspaceFolder: WorkspaceFolder | undefined;

connection.onInitialize((params: InitializeParams, _, progress) => {
	progress.begin('Initializing DevReplay server');

	if (params.workspaceFolders && params.workspaceFolders.length > 0) {
		workspaceFolder = params.workspaceFolders[0];
	}
	const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Incremental;
	setupDocumentsListeners();

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: syncKind,
				willSaveWaitUntil: false,
				save: {
					includeText: false
				}
			},
			codeActionProvider: {
				codeActionKinds: [CodeActionKind.QuickFix],
				resolveProvider: true
			},
			executeCommandProvider: {
				commands: ['devreplay.fix'],
			},
		},
	};
});

/**
 * Analyzes the text document for problems.
 * @param document text document to analyze
 */
function validate(document: TextDocument) {
	const diagnostics: Diagnostic[] = [];
	const results = lintFile(document);
	for (let i = 0; i < results.length; i += 1) {
		diagnostics.push(makeDiagnostic(results[i], i));
	}
	connection.sendDiagnostics({
		uri: document.uri,
		version: document.version,
		diagnostics
	});
}

function lintFile(doc: TextDocument) {
	const ruleFile = URI.parse(getDevReplayPath()).fsPath;
	const fileName = URI.parse(doc.uri).fsPath;
	if (fileName.endsWith(ruleFile) || fileName.endsWith('.git')) {
		return [];
	}

	return lint([fileName], ruleFile);
}

function makeDiagnostic(result: LintOut, code: number): Diagnostic {
	const range: Range = {
		start: {
			line: result.position.start.line - 1,
			character: result.position.start.character - 1},
		end: {
			line: result.position.end.line - 1,
			character: result.position.end.character - 1}
	};
	const message = code2String(result.rule);
	const severity = convertSeverityToDiagnostic(makeSeverity(result.rule.severity));
	return Diagnostic.create(range, message, severity, code, 'devreplay');
}

function setupDocumentsListeners() {
	documents.listen(connection);

	documents.onDidOpen((event) => {
		validate(event.document);
	});

	documents.onDidChangeContent((change) => {
		validate(change.document);
	});

	documents.onDidSave((change) => {
		validate(change.document);
	});

	documents.onDidClose((close) => {
		connection.sendDiagnostics({ uri: close.document.uri, diagnostics: []});
	});

	connection.onCodeAction((params) => {
		const diagnostics = params.context.diagnostics.filter((diag) => diag.source === 'devreplay');
		if (diagnostics.length === 0) {
			return [];
		}
		const textDocument = documents.get(params.textDocument.uri);
		if (textDocument === undefined) {
			return [];
		}
		const codeActions: CodeAction[] = [];
		const results = lintFile(textDocument);
		diagnostics.forEach((diagnostic) => {
			const targetRule = results[Number(diagnostic.code)];
			const title = makeFixTitle(targetRule.rule.ruleId);
			const fixAction = CodeAction.create(
				title,
				createEditByPattern(textDocument, diagnostic.range, targetRule.rule),
				CodeActionKind.QuickFix);
			fixAction.diagnostics = [diagnostic];
			codeActions.push(fixAction);
		});

		return codeActions;
	});
}

function createEditByPattern(document: TextDocument, range: Range, pattern: Rule): WorkspaceEdit {
	const textDocumentIdentifier: VersionedTextDocumentIdentifier = {uri: document.uri, version: document.version};
	const newText = fixWithRules(document.getText(range), [pattern]);
	if (newText !== undefined) {
		const edits = [TextEdit.replace(range, newText)];

		return { documentChanges: [TextDocumentEdit.create(textDocumentIdentifier, edits)] };
	}

	return { documentChanges: [] };
}

function makeFixTitle(ruleId?: string | string[]) {
	if (ruleId) {
		return `Fix to ${ruleId}`;
	}
	return 'Fix by DevReplay';
}

function disableRule(rule: Rule) {
	// ルールのIDを取得
	const ruleId = rule.ruleId;
	// ルールファイルを開く
	const ruleFile = URI.parse(getDevReplayPath()).fsPath;
	const rules = JSON.parse(fs.readFileSync(ruleFile, 'utf8')) as Rule[];
	// ルールの場所を特定
	const ruleIndex = rules.findIndex((r) => r.ruleId === ruleId);
	// TODO: 該当ルールのseverityを"off"に変更
	rules[ruleIndex].severity = 'E';
	// ルールを保存
	fs.writeFileSync(ruleFile, JSON.stringify(rules, null, '\t'));
}

enum RuleSeverity {
	// Original DevReplay values
	info = 'I',
	warn = 'W',
	error = 'E',
	hint = 'H',

	// Added severity override changes
	off = 'O',
	default = 'default',
	downgrade = 'downgrade',
	upgrade = 'upgrade'
}

function convertSeverityToDiagnostic(severity: string) {
	switch (severity) {
		case 'E':
			return DiagnosticSeverity.Error;
		case 'W':
			return DiagnosticSeverity.Warning;
		case 'I':
			return DiagnosticSeverity.Information;
		case 'H':
			return DiagnosticSeverity.Hint;
		default:
			return DiagnosticSeverity.Warning;
	}
}

function adjustSeverityForOverride(severity: RuleSeverity, severityOverride?: RuleSeverity) {
	switch (severityOverride) {
		case RuleSeverity.off:
		case RuleSeverity.info:
		case RuleSeverity.warn:
		case RuleSeverity.error:
		case RuleSeverity.hint:
			return severityOverride;

		case RuleSeverity.downgrade:
			switch (convertSeverityToDiagnostic(severity)) {
				case DiagnosticSeverity.Error:
					return RuleSeverity.warn;
				case DiagnosticSeverity.Warning:
					return RuleSeverity.info;
				case DiagnosticSeverity.Information:
				case DiagnosticSeverity.Hint:
					return RuleSeverity.hint;
			}

		case RuleSeverity.upgrade:
			switch (convertSeverityToDiagnostic(severity)) {
				case DiagnosticSeverity.Hint:
					return RuleSeverity.info;
				case DiagnosticSeverity.Information:
					return RuleSeverity.warn;
				case DiagnosticSeverity.Warning:
				case DiagnosticSeverity.Error:
					return RuleSeverity.error;
			}

		default:
			return severity;
	}
}

export function writePattern(rules: Rule[]) {
	const outPatterns = readCurrentPattern().concat(rules);
	const patternStr = JSON.stringify(outPatterns, undefined, 2);
	const filePath = getDevReplayPath();
	try {
		fs.writeFileSync(filePath, patternStr);
	} catch(err) {
		console.log(err.name);
	}
}


function readCurrentPattern(): Rule[] {
	const devreplayPath = getDevReplayPath();
	if (devreplayPath === undefined) { return []; }
	let fileContents = undefined;
	try{
		fileContents = tryReadFile(devreplayPath);
	} catch {
		return [];
	}
	if (fileContents === undefined) {
		return [];
	}
	return JSON.parse(fileContents) as Rule[];
}

function getDevReplayPath() {
	return path.join(workspaceFolder!.uri, '.devreplay.json');
}

export function tryReadFile(filename: string) {
	if (!fs.existsSync(filename)) {
		throw new Error(`Unable to open file: ${filename}`);
	}
	const buffer = Buffer.allocUnsafe(256);
	const fd = fs.openSync(filename, 'r');
	try {
		fs.readSync(fd, buffer, 0, 256, 0);
		if (buffer.readInt8(0) === 0x47 && buffer.readInt8(188) === 0x47) {
			console.log(`${filename}: ignoring MPEG transport stream\n`);

			return undefined;
		}
	} finally {
		fs.closeSync(fd);
	}

	return fs.readFileSync(filename, 'utf8');
}

// Listen on the connection
connection.listen();
