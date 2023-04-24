/**
 * AGLint Language Server for VSCode
 */

import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    InitializeResult,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

// eslint-disable-next-line import/no-extraneous-dependencies
import {
    LinterConfig, scan, walk, Linter, buildConfigForDirectory,
} from '@adguard/aglint';
import { ParsedPath, join as joinPath } from 'path';
import { fileURLToPath } from 'url';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/**
 * URL to the AGLint repository
 */
const AGLINT_URL = 'https://github.com/AdguardTeam/AGLint';

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

/**
 * Root folder of the VSCode workspace
 */
let workspaceRoot: string | undefined;

type CachedPaths = { [key: string]: LinterConfig };

/**
 * Cache of the scanned workspace
 */
let cachedPaths: CachedPaths | undefined;

/**
 * Scan the workspace and cache the result.
 */
async function cachePaths(): Promise<boolean> {
    // Cache the scan result
    try {
        if (!workspaceRoot) {
            throw new Error('Couldn\'t determine the workspace root of the VSCode instance');
        }

        // Get the config for the cwd, should exist
        const rootConfig = await buildConfigForDirectory(workspaceRoot);

        const scanResult = await scan(workspaceRoot);

        // Create a map of paths to configs
        const newCache: CachedPaths = {};

        await walk(
            scanResult,
            {
                file: async (path: ParsedPath, config: LinterConfig) => {
                    const filePath = joinPath(path.dir, path.base);

                    // Add the file path to the new cache map with the resolved config
                    newCache[filePath] = { ...config };
                },
            },
            rootConfig,
        );

        // Update the whole cache
        cachedPaths = { ...newCache };

        connection.console.info(`AGLint successfully scanned and cached the workspace: ${workspaceRoot}`);

        // Notify the client that the caching succeeded
        await connection.sendNotification('aglint/status');

        return true;
    } catch (error: unknown) {
        // Clear the cache
        cachedPaths = undefined;

        // Log the error
        connection.console.error(`AGLint failed to scan and cache the workspace: ${workspaceRoot}`);

        if (error instanceof Error) {
            if (error.name === 'NoConfigError') {
                /* eslint-disable max-len */
                connection.console.error([
                    'AGLint couldn\'t find the config file. To set up a configuration file for this project, please run:',
                    '',
                    '    If you use NPM:\tnpx aglint init',
                    '    If you use Yarn:\tyarn aglint init',
                    '',
                    'IMPORTANT: The init command creates a root config file, so be sure to run it in the root directory of your project!',
                    '',
                    'AGLint will try to find the config file in the current directory (cwd), but if the config file is not found',
                    'there, it will try to find it in the parent directory, and so on until it reaches your OS root directory.',
                ].join('\n'));
                /* eslint-enable max-len */
            } else {
                connection.console.error(error.toString());
            }
        } else {
            connection.console.error(JSON.stringify(error));
        }

        // Notify the client that the caching failed
        await connection.sendNotification('aglint/status', { error });

        return false;
    }
}

connection.onInitialize(async (params: InitializeParams) => {
    const { capabilities } = params;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);

    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);

    // TODO: Define the capabilities of the language server here
    const result: InitializeResult = {
        capabilities: {},
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }

    // TODO: Better way to get the workspace root
    workspaceRoot = params.workspaceFolders ? fileURLToPath(params.workspaceFolders[0].uri) : undefined;

    connection.console.info(`AGLint Language Server initialized in workspace: ${workspaceRoot}`);

    return result;
});

/**
 * Lint the document and send the diagnostics to VSCode. It handles the
 * ignore & config files, since it uses the cached scan result, which
 * is based on the AGLint CLI logic.
 *
 * @param textDocument Document to lint
 */
async function lintFile(textDocument: TextDocument): Promise<void> {
    try {
        const documentPath = fileURLToPath(textDocument.uri);

        // If the file is not present in the cached path map, it means that it is
        // not lintable or it is marked as ignored in some .aglintignore file.
        // In this case, we should not lint it.
        // If the file is present in the cached path map, it means that it is
        // lintable and it has a config associated with it, at least the default one
        // (this is the natural behavior of the AGLint CLI's scan/walk functions).
        const config = cachedPaths !== undefined ? cachedPaths[documentPath] : undefined;

        // Skip linting if the file is not present in the cached path map
        if (config === undefined) {
            return;
        }

        // This is the actual content of the file in the editor
        const text = textDocument.getText();

        // Create the linter instance and lint the document text
        const linter = new Linter(true, config);
        const { problems } = linter.lint(text);

        // Convert problems to VSCode diagnostics
        const diagnostics: Diagnostic[] = [];

        for (const problem of problems) {
            const severity = problem.severity === 'warn' || problem.severity === 1
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Error;

            const diagnostic: Diagnostic = {
                severity,

                // Linting problems using 1-based line numbers, but VSCode uses 0-based line numbers
                range: {
                    start: {
                        line: problem.position.startLine - 1,
                        character: problem.position.startColumn !== undefined ? problem.position.startColumn : 0,
                    },
                    end: {
                        line: problem.position.endLine - 1,
                        character: problem.position.endColumn !== undefined ? problem.position.endColumn : 0,
                    },
                },

                message: problem.message,

                source: 'aglint',
            };

            // Add permalink to the rule documentation
            if (problem.rule) {
                diagnostic.code = problem.rule;
                diagnostic.codeDescription = {
                    href: `${AGLINT_URL}#${problem.rule}`,
                };
            }

            diagnostics.push(diagnostic);

            // Notify the client that the linting succeeded
            await connection.sendNotification('aglint/status');
        }

        // Send the computed diagnostics to VSCode.
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    } catch (error: unknown) {
        connection.console.error(`AGLint failed to lint the document: ${textDocument.uri}`);

        if (error instanceof Error) {
            connection.console.error(error.toString());
        } else {
            connection.console.error(JSON.stringify(error));
        }

        // Reset the diagnostics for the document
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });

        // Notify the client that the linting failed
        await connection.sendNotification('aglint/status', { error });
    }
}

// Called when any of monitored file paths change
connection.onDidChangeWatchedFiles(async () => {
    // Reset current file diagnostics
    documents.all().forEach((document) => {
        connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    });

    // Re-scan the workspace
    await cachePaths();

    // Revalidate any open text documents
    documents.all().forEach(lintFile);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    lintFile(change.document);
});

connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(() => {
            connection.console.log('Workspace folder change event received.');
        });
    }

    // Scan the workspace and cache the result
    await cachePaths();

    // Lint all open documents when the server starts
    documents.all().forEach(lintFile);
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.console.info(`AGLint server running in Node ${process.version}`);