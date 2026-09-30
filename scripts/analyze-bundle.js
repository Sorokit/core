#!/usr/bin/env node
/**
 * Comprehensive Bundle Analysis Script
 * 
 * Analyzes bundle for:
 * - Unused exports and dead code
 * - Tree-shaking opportunities
 * - Bundle size breakdown
 * - ESM health metrics
 * 
 * Usage:
 *   node scripts/analyze-bundle.js [options]
 * 
 * Options:
 *   --json           Output JSON format
 *   --threshold 5    Size threshold in KB (default: 5KB)
 *   --verbose, -v    Verbose output
 *   --ci             CI mode (exit 1 on failures)
 */

const fs = require('fs');
const path = require('path');
const { gzipSync } = require('zlib');

const DEFAULT_THRESHOLD_BYTES = 5 * 1024; // 5KB

/**
 * Parse CLI arguments
 */
function parseArgs(args = process.argv.slice(2)) {
  const options = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    json: false,
    verbose: false,
    ci: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--threshold' || arg === '-t') {
      const val = parseFloat(args[++i]);
      if (!isNaN(val)) options.thresholdBytes = val * 1024;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--ci') {
      options.ci = true;
    }
  }

  return options;
}

/**
 * Recursively find all TypeScript files excluding tests
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
 * Extract exported symbols with metadata
 */
function extractExports(fileContent, filePath) {
  const lines = fileContent.split('\n');
  const exports = [];

  // Match various export patterns
  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+([A-Za-z0-9_$]+)/;
  const namedExportRegex = /export\s*\{([^}]+)\}/;
  const defaultExportRegex = /export\s+default\s+/;

  lines.forEach((line, idx) => {
    // Direct exports
    const match = line.match(exportRegex);
    if (match && match[1]) {
      exports.push({
        name: match[1],
        line: idx + 1,
        file: filePath,
        type: getExportType(line),
        raw: line.trim(),
        approxBytes: estimateBytes(fileContent, match[1], idx),
      });
    }

    // Named exports
    const namedMatch = line.match(namedExportRegex);
    if (namedMatch && namedMatch[1] && !line.includes(' from ')) {
      const names = namedMatch[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      
      for (const name of names) {
        if (name && /^[A-Za-z0-9_$]+$/.test(name)) {
          exports.push({
            name,
            line: idx + 1,
            file: filePath,
            type: 'named-export',
            raw: line.trim(),
            approxBytes: 60,
          });
        }
      }
    }

    // Default exports
    if (defaultExportRegex.test(line)) {
      exports.push({
        name: 'default',
        line: idx + 1,
        file: filePath,
        type: 'default-export',
        raw: line.trim(),
        approxBytes: 100,
      });
    }
  });

  return exports;
}

/**
 * Determine export type from code line
 */
function getExportType(line) {
  if (line.includes('function')) return 'function';
  if (line.includes('class')) return 'class';
  if (line.includes('const')) return 'const';
  if (line.includes('let')) return 'let';
  if (line.includes('var')) return 'var';
  if (line.includes('enum')) return 'enum';
  if (line.includes('interface')) return 'interface';
  if (line.includes('type')) return 'type';
  return 'unknown';
}

/**
 * Estimate bytes for an export (rough approximation)
 */
function estimateBytes(content, symbolName, startLine) {
  const lines = content.split('\n');
  let size = 0;
  let braceCount = 0;
  let inBlock = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    size += line.length + 1;

    if (line.includes('{')) {
      braceCount += (line.match(/\{/g) || []).length;
      inBlock = true;
    }
    if (line.includes('}')) {
      braceCount -= (line.match(/\}/g) || []).length;
    }

    if (inBlock && braceCount === 0) break;
    if (!inBlock && (line.includes(';') || line.includes(','))) break;
    if (size > 5000) break; // Cap at 5KB per symbol
  }

  return Math.max(size, 50);
}

/**
 * Analyze bundle health and tree-shaking
 */
function analyzeBundleHealth(distDir) {
  const health = {
    bundles: [],
    totalSize: 0,
    totalGzippedSize: 0,
    treeShakingIssues: [],
  };

  if (!fs.existsSync(distDir)) {
    return health;
  }

  const files = fs.readdirSync(distDir, { recursive: true });
  
  for (const file of files) {
    if (typeof file === 'string' && file.endsWith('.mjs')) {
      const fullPath = path.join(distDir, file);
      const content = fs.readFileSync(fullPath);
      const size = content.length;
      const gzipped = gzipSync(content, { level: 9 }).length;

      health.bundles.push({
        file,
        sizeBytes: size,
        sizeKb: (size / 1024).toFixed(2),
        gzippedBytes: gzipped,
        gzippedKb: (gzipped / 1024).toFixed(2),
        compressionRatio: ((1 - gzipped / size) * 100).toFixed(1) + '%',
      });

      health.totalSize += size;
      health.totalGzippedSize += gzipped;

      // Check for tree-shaking issues
      const contentStr = content.toString();
      if (file.includes('wallet') || file.includes('account')) {
        if (contentStr.includes('dist/index')) {
          health.treeShakingIssues.push({
            file,
            issue: 'References full SDK bundle (breaks tree-shaking)',
          });
        }
      }
    }
  }

  return health;
}

/**
 * Find unused exports
 */
function findUnusedExports(allExports, allContents) {
  const unusedSymbols = [];
  let totalUnusedBytes = 0;

  for (const exp of allExports) {
    if (exp.name === 'default') continue; // Skip default exports

    let referencesCount = 0;
    const identifier = exp.name;
    const escapedIdentifier = identifier.replace(/\$/g, '\\$');

    for (const [file, content] of allContents.entries()) {
      if (file === exp.file) {
        // Count occurrences within same file (should be > 1 if used)
        const regex = new RegExp(`\\b${escapedIdentifier}\\b`, 'g');
        const matches = content.match(regex);
        if (matches && matches.length > 1) {
          referencesCount += matches.length - 1;
        }
      } else {
        // Check if used in other files
        const regex = new RegExp(`\\b${escapedIdentifier}\\b`);
        if (regex.test(content)) {
          referencesCount++;
        }
      }
    }

    if (referencesCount === 0) {
      unusedSymbols.push(exp);
      totalUnusedBytes += exp.approxBytes;
    }
  }

  return { unusedSymbols, totalUnusedBytes };
}

/**
 * Identify dead code paths (simple heuristic)
 */
function findDeadCode(allContents) {
  const deadCodeCandidates = [];

  for (const [file, content] of allContents.entries()) {
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
      // Check for unreachable code after return
      if (idx > 0 && lines[idx - 1].trim().startsWith('return') && 
          line.trim() && !line.trim().startsWith('}') && 
          !line.trim().startsWith('//')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Code after return statement',
        });
      }

      // Check for if (false) blocks
      if (line.includes('if (false)') || line.includes('if(false)')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Condition always false',
        });
      }

      // Check for unreachable code after throw
      if (idx > 0 && lines[idx - 1].trim().startsWith('throw') && 
          line.trim() && !line.trim().startsWith('}') && 
          !line.trim().startsWith('//')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Code after throw statement',
        });
      }
    });
  }

  return deadCodeCandidates;
}

/**
 * Main analysis function
 */
function analyzeBundle(options = {}) {
  const opts = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    verbose: false,
    ...options,
  };

  // Scan source files
  const files = findSourceFiles(opts.srcDir);
  const allContents = new Map();
  const allExports = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    allContents.set(file, content);
    const fileExports = extractExports(content, file);
    allExports.push(...fileExports);
  }

  // Find unused exports
  const { unusedSymbols, totalUnusedBytes } = findUnusedExports(allExports, allContents);

  // Find dead code
  const deadCode = findDeadCode(allContents);

  // Analyze bundle health
  const bundleHealth = analyzeBundleHealth(opts.distDir);

  // Calculate metrics
  const passed = totalUnusedBytes <= opts.thresholdBytes && 
                 bundleHealth.treeShakingIssues.length === 0;

  return {
    passed,
    analysis: {
      scannedFilesCount: files.length,
      totalExportsCount: allExports.length,
      unusedExportsCount: unusedSymbols.length,
      deadCodePaths: deadCode.length,
      totalUnusedBytes,
      totalUnusedKb: (totalUnusedBytes / 1024).toFixed(2),
      thresholdBytes: opts.thresholdBytes,
      thresholdKb: (opts.thresholdBytes / 1024).toFixed(2),
    },
    unusedExports: unusedSymbols,
    deadCode: deadCode.length > 20 ? deadCode.slice(0, 20) : deadCode,
    deadCodeTotal: deadCode.length,
    bundleHealth: {
      bundles: bundleHealth.bundles,
      totalSizeKb: (bundleHealth.totalSize / 1024).toFixed(2),
      totalGzippedKb: (bundleHealth.totalGzippedSize / 1024).toFixed(2),
      compressionRatio: bundleHealth.totalSize > 0 
        ? ((1 - bundleHealth.totalGzippedSize / bundleHealth.totalSize) * 100).toFixed(1) + '%'
        : 'N/A',
      treeShakingIssues: bundleHealth.treeShakingIssues,
    },
    treeShakingOpportunities: generateTreeShakingRecommendations(unusedSymbols, bundleHealth),
  };
}

/**
 * Generate tree-shaking recommendations
 */
function generateTreeShakingRecommendations(unusedSymbols, bundleHealth) {
  const recommendations = [];

  if (unusedSymbols.length > 0) {
    recommendations.push({
      type: 'unused-exports',
      priority: 'high',
      message: `Remove ${unusedSymbols.length} unused exports to enable better tree-shaking`,
      potentialSavings: Math.floor(unusedSymbols.reduce((sum, s) => sum + s.approxBytes, 0) / 1024) + ' KB',
    });
  }

  if (bundleHealth.treeShakingIssues.length > 0) {
    recommendations.push({
      type: 'bundle-references',
      priority: 'critical',
      message: 'Fix circular dependencies or full-bundle imports in sub-packages',
      affectedFiles: bundleHealth.treeShakingIssues.map(i => i.file),
    });
  }

  if (bundleHealth.bundles.some(b => parseInt(b.gzippedKb) > 50)) {
    recommendations.push({
      type: 'bundle-size',
      priority: 'medium',
      message: 'Consider splitting large bundles into smaller chunks',
      largeBundles: bundleHealth.bundles
        .filter(b => parseInt(b.gzippedKb) > 50)
        .map(b => `${b.file} (${b.gzippedKb} KB gzipped)`),
    });
  }

  return recommendations;
}

/**
 * CLI Runner
 */
function run() {
  const options = parseArgs();
  
  console.log('🔍 Analyzing bundle...\n');
  
  const results = analyzeBundle(options);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.passed ? 0 : 1);
  }

  // Print report
  printReport(results, options);

  if (options.ci && !results.passed) {
    process.exit(1);
  }
}

/**
 * Print formatted report
 */
function printReport(results, options) {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('              BUNDLE ANALYSIS & TREE-SHAKING REPORT                ');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { analysis } = results;

  console.log('📊 Analysis Summary:');
  console.log(`   • Scanned files:      ${analysis.scannedFilesCount}`);
  console.log(`   • Total exports:      ${analysis.totalExportsCount}`);
  console.log(`   • Unused exports:     ${analysis.unusedExportsCount}`);
  console.log(`   • Dead code paths:    ${analysis.deadCodePaths}`);
  console.log(`   • Unused code size:   ${analysis.totalUnusedKb} KB (threshold: ${analysis.thresholdKb} KB)`);
  console.log(`   • Status:             ${results.passed ? '✅ PASSED' : '❌ FAILED'}\n`);

  // Bundle size breakdown
  if (results.bundleHealth.bundles.length > 0) {
    console.log('📦 Bundle Size Breakdown:');
    for (const bundle of results.bundleHealth.bundles) {
      console.log(`   • ${bundle.file.padEnd(30)} ${bundle.gzippedKb.padStart(8)} KB gzipped (${bundle.compressionRatio} compression)`);
    }
    console.log(`   • Total:                          ${results.bundleHealth.totalGzippedKb.padStart(8)} KB gzipped\n`);
  }

  // Unused exports
  if (results.unusedExports.length > 0) {
    console.log(`⚠️  Unused Exports (${results.unusedExports.length}):`);
    const shown = results.unusedExports.slice(0, 15);
    for (const item of shown) {
      const relFile = path.relative(path.resolve(__dirname, '..'), item.file);
      console.log(`   • ${item.name.padEnd(30)} ${relFile}:${item.line} (~${item.approxBytes} bytes)`);
    }
    if (results.unusedExports.length > 15) {
      console.log(`   ... and ${results.unusedExports.length - 15} more\n`);
    } else {
      console.log('');
    }
  }

  // Dead code
  if (results.deadCode.length > 0) {
    console.log(`💀 Dead Code Detected (${results.deadCodeTotal}):`);
    for (const item of results.deadCode.slice(0, 10)) {
      const relFile = path.relative(path.resolve(__dirname, '..'), item.file);
      console.log(`   • ${relFile}:${item.line} - ${item.reason}`);
    }
    if (results.deadCodeTotal > 10) {
      console.log(`   ... and ${results.deadCodeTotal - 10} more\n`);
    } else {
      console.log('');
    }
  }

  // Tree-shaking issues
  if (results.bundleHealth.treeShakingIssues.length > 0) {
    console.log('🚨 Tree-Shaking Issues:');
    for (const issue of results.bundleHealth.treeShakingIssues) {
      console.log(`   • ${issue.file}: ${issue.issue}`);
    }
    console.log('');
  }

  // Recommendations
  if (results.treeShakingOpportunities.length > 0) {
    console.log('💡 Tree-Shaking Opportunities:');
    for (const rec of results.treeShakingOpportunities) {
      const priority = rec.priority === 'critical' ? '🔴' : rec.priority === 'high' ? '🟠' : '🟡';
      console.log(`   ${priority} ${rec.message}`);
      if (rec.potentialSavings) {
        console.log(`      Potential savings: ${rec.potentialSavings}`);
      }
      if (rec.affectedFiles) {
        console.log(`      Affected: ${rec.affectedFiles.join(', ')}`);
      }
      if (rec.largeBundles) {
        rec.largeBundles.forEach(b => console.log(`      ${b}`));
      }
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  
  if (results.passed) {
    console.log('✅ Bundle analysis passed!');
  } else {
    console.log('❌ Bundle analysis failed. See issues above.');
  }
}

if (require.main === module) {
  run();
}

module.exports = { analyzeBundle, parseArgs };
