import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? '.');
const contractsRoot = resolve(root, 'src/contracts');
const violations = [];

function admit(specifier, file) {
  if (specifier === 'zod') return;
  if (specifier.startsWith('.')) {
    const target = relative(contractsRoot, resolve(dirname(file), specifier));
    if (!isAbsolute(target) && target !== '..' && !target.startsWith(`..${sep}`)) return;
  }
  violations.push(`${relative(root, file)}: contracts may import only zod or another contract module.`);
}

function visit(node, file) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    if (ts.isStringLiteral(node.moduleSpecifier)) admit(node.moduleSpecifier.text, file);
    else violations.push(`${relative(root, file)}: use a static module specifier.`);
  }
  if (ts.isCallExpression(node) && (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  )) {
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteral(argument)) admit(argument.text, file);
    else violations.push(`${relative(root, file)}: computed imports are not permitted in contracts.`);
  }
  ts.forEachChild(node, (child) => visit(child, file));
}

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) violations.push(`${relative(root, path)}: contract sources must not be symlinks.`);
    else if (entry.isDirectory()) await scan(path);
    else if (entry.name.endsWith('.ts')) {
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      visit(source, path);
    }
  }
}

await scan(contractsRoot);
if (violations.length) {
  console.error(`BOUNDARY_VIOLATION\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Contract dependency boundaries passed. This check is not a security sandbox.');
}
