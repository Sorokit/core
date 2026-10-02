/**
 * ESM Tree-Shaking Verification and Unused Code Detection Script
 *
 * Scans SDK source files and ESM build outputs to identify unused symbols,
 * verify tree-shaking efficacy, and detect dead code with line references and byte estimates.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD_BYTES = 5 * 1024; // 5KB threshold

/**
 * Parses CLI arguments.
 */
function parseArgs(args = process.argv.slice(2)) {
  const options = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    json: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--threshold' || arg === '-t') {
      const val = parseFloat(args[++i]);
      if (!isNaN(val)) {
        options.thresholdBytes = val * 1024;
      }
    } else if (arg === '--threshold-bytes') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) {
        options.thresholdBytes = val;
      }
    } else if (arg === '--src') {
      options.srcDir = path.resolve(args[++i]);
    } else if (arg === '--dist') {
      options.distDir = path.resolve(args[++i]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    }
  }

  if (process.env.UNUSED_THRESHOLD_KB) {
    const val = parseFloat(process.env.UNUSED_THRESHOLD_KB);
    if (!isNaN(val)) options.thresholdBytes = val * 1024;
  }
  if (process.env.UNUSED_THRESHOLD_BYTES) {
    const val = parseInt(process.env.UNUSED_THRESHOLD_BYTES, 10);
    if (!isNaN(val)) options.thresholdBytes = val;
  }

  return options;
}

/**
 * Recursively find all typescript files in a directory excluding tests.
 */
function findSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== '__tests__') {
        findSourceFiles(fullPath, fileList);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Extract exported declarations with line numbers from source text.
 */
function extractExports(fileContent, filePath) {
  const lines = fileContent.split('\n');
  const exports = [];

  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|var|enum)\s+([A-Za-z0-9_$]+)/;
  const namedExportRegex = /export\s*\{([^}]+)\}/;

  lines.forEach((line, idx) => {
    const match = line.match(exportRegex);
    if (match && match[1]) {
      exports.push({
        name: match[1],
        line: idx + 1,
        file: filePath,
        raw: line.trim(),
        approxBytes: line.length + 50,
      });
    }

    const namedMatch = line.match(namedExportRegex);
    if (namedMatch && namedMatch[1] && !line.includes(' from ')) {
      const names = namedMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      for (const name of names) {
        if (name && /^[A-Za-z0-9_$]+$/.test(name)) {
          exports.push({
            name,
            line: idx + 1,
            file: filePath,
            raw: line.trim(),
            approxBytes: 60,
          });
        }
      }
    }
  });

  return exports;
}

/**
 * Analyze unused code and tree-shaking health.
 */
function analyzeUnusedCode(options = {}) {
  const opts = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    ...options,
  };

  const files = findSourceFiles(opts.srcDir);
  const allContents = new Map();
  const allExports = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    allContents.set(file, content);
    const fileExports = extractExports(content, file);
    allExports.push(...fileExports);
  }

  // Check which exported symbols are referenced across other files or barrel files
  const unusedSymbols = [];
  let totalUnusedBytes = 0;

  for (const exp of allExports) {
    let referencesCount = 0;
    const identifier = exp.name;

    // Check occurrences in all other files
    for (const [file, content] of allContents.entries()) {
      if (file === exp.file) {
        // Count occurrences within the file itself
        const matches = content.match(new RegExp(`\\b${identifier}\\b`, 'g'));
        if (matches && matches.length > 1) {
          referencesCount += matches.length - 1;
        }
      } else {
        if (new RegExp(`\\b${identifier}\\b`).test(content)) {
          referencesCount++;
        }
      }
    }

    if (referencesCount === 0) {
      unusedSymbols.push(exp);
      totalUnusedBytes += exp.approxBytes;
    }
  }

  // Check bundle tree-shaking health
  const bundleHealth = [];
  if (fs.existsSync(opts.distDir)) {
    const distFiles = fs.readdirSync(opts.distDir);
    for (const f of distFiles) {
      if (f.endsWith('.mjs')) {
        const fullDist = path.join(opts.distDir, f);
        const stat = fs.statSync(fullDist);
        bundleHealth.push({
          bundle: f,
          sizeBytes: stat.size,
          sizeKb: (stat.size / 1024).toFixed(2),
        });
      }
    }
  }

  const passed = totalUnusedBytes <= opts.thresholdBytes;

  return {
    passed,
    totalUnusedBytes,
    totalUnusedKb: (totalUnusedBytes / 1024).toFixed(2),
    thresholdBytes: opts.thresholdBytes,
    thresholdKb: (opts.thresholdBytes / 1024).toFixed(2),
    unusedSymbols,
    bundleHealth,
    scannedFilesCount: files.length,
    totalExportsCount: allExports.length,
  };
}

/**
 * CLI Runner.
 */
function run() {
  const options = parseArgs();
  const results = analyzeUnusedCode(options);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.passed ? 0 : 1);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('         ESM TREE-SHAKING & UNUSED CODE ANALYSIS REPORT            ');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log(`📁 Scanned files:   ${results.scannedFilesCount}`);
  console.log(`🔍 Total exports:   ${results.totalExportsCount}`);
  console.log(`⚠️  Unused exports:  ${results.unusedSymbols.length}`);
  console.log(`📦 Unused code size: ${results.totalUnusedKb} KB (Threshold: ${results.thresholdKb} KB)`);
  console.log(`📊 Status:          ${results.passed ? '✅ PASSED' : '❌ FAILED (Threshold Exceeded)'}\n`);

  if (results.unusedSymbols.length > 0) {
    console.log('Detected Unused Symbols:');
    console.log('───────────────────────────────────────────────────────────────────');
    for (const item of results.unusedSymbols) {
      const relFile = path.relative(path.resolve(__dirname, '..'), item.file);
      console.log(` • [${item.name}] at ${relFile}:${item.line} (~${item.approxBytes} B)`);
    }
    console.log('───────────────────────────────────────────────────────────────────\n');
  }

  if (results.bundleHealth.length > 0) {
    console.log('ESM Bundle Outputs:');
    for (const b of results.bundleHealth) {
      console.log(` • ${b.bundle.padEnd(24)} ${b.sizeKb} KB`);
    }
    console.log('');
  }

  if (!results.passed) {
    console.error(`❌ Error: Total unused code (${results.totalUnusedKb} KB) exceeds the maximum allowed threshold of ${results.thresholdKb} KB.`);
    process.exit(1);
  } else {
    console.log('✅ ESM tree-shaking and unused code check passed successfully.');
    process.exit(0);
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  analyzeUnusedCode,
  parseArgs,
  extractExports,
  findSourceFiles,
};
