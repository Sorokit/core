import {
  detectUpgrade,
  getMigrationSteps,
  validateUpgradeCompatibility,
  UpgradeInfo,
  MigrationStep,
  CompatibilityResult,
} from './upgradeHelper';
import { SorokitResult } from '../types/result';

jest.mock('./upgradeHelper', () => {
  const actual = jest.requireActual('./upgradeHelper');
  return {
    ...actual,
    __esModule: true,
  };
});

describe('upgradeHelper', () => {
  describe('detectUpgrade', () => {
    it('returns not upgraded when hashes match', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const hash = 'abc123hash';
      const result = await detectUpgrade(contractId, hash);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isUpgraded).toBe(false);
        expect(result.value.contractId).toBe(contractId);
        expect(result.value.oldHash).toBe(hash);
      }
    });

    it('detects upgrade when hashes differ', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const oldHash = 'oldhash123';
      const result = await detectUpgrade(contractId, oldHash);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isUpgraded).toBe(true);
        expect(result.value.contractId).toBe(contractId);
        expect(result.value.oldHash).toBe(oldHash);
        expect(result.value.currentHash).toBeDefined();
        expect(result.value.currentHash).not.toBe(oldHash);
      }
    });

    it('returns error for invalid contract id', async () => {
      const result = await detectUpgrade('', 'somehash');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('getMigrationSteps', () => {
    it('returns empty steps when versions are equal', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const result = await getMigrationSteps(contractId, '1.0.0', '1.0.0');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.steps).toEqual([]);
        expect(result.value.fromVersion).toBe('1.0.0');
        expect(result.value.toVersion).toBe('1.0.0');
      }
    });

    it('generates migration steps across versions', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const result = await getMigrationSteps(contractId, '1.0.0', '2.0.0');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.steps.length).toBeGreaterThan(0);
        expect(result.value.fromVersion).toBe('1.0.0');
        expect(result.value.toVersion).toBe('2.0.0');
        result.value.steps.forEach((step: MigrationStep) => {
          expect(step.description).toBeDefined();
          expect(typeof step.description).toBe('string');
          expect(step.order).toBeGreaterThanOrEqual(0);
        });
      }
    });

    it('handles missing metadata gracefully', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
      const result = await getMigrationSteps(contractId, '', '');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.steps).toEqual([]);
      }
    });

    it('returns error for invalid contract id', async () => {
      const result = await getMigrationSteps('', '1.0.0', '2.0.0');
      expect(result.ok).toBe(false);
    });
  });

  describe('validateUpgradeCompatibility', () => {
    const baseContract = {
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      version: '1.0.0',
      functions: [
        { name: 'transfer', inputs: ['from', 'to', 'amount'], outputs: ['bool'] },
        { name: 'balance', inputs: ['owner'], outputs: ['i128'] },
      ],
      storage: [{ key: 'balances', type: 'map' }],
    };

    it('returns compatible for identical interfaces', async () => {
      const result = await validateUpgradeCompatibility(baseContract, { ...baseContract, version: '1.1.0' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.compatible).toBe(true);
        expect(result.value.breakingChanges).toEqual([]);
      }
    });

    it('returns compatible when new contract adds functions', async () => {
      const newContract = {
        ...baseContract,
        version: '1.1.0',
        functions: [
          ...baseContract.functions,
          { name: 'mint', inputs: ['to', 'amount'], outputs: ['bool'] },
        ],
      };
      const result = await validateUpgradeCompatibility(baseContract, newContract);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.compatible).toBe(true);
      }
    });

    it('returns incompatible when a function is removed', async () => {
      const newContract = {
        ...baseContract,
        version: '2.0.0',
        functions: [baseContract.functions[0]],
      };
      const result = await validateUpgradeCompatibility(baseContract, newContract);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.compatible).toBe(false);
        expect(result.value.breakingChanges.length).toBeGreaterThan(0);
      }
    });

    it('returns incompatible when a function signature changes', async () => {
      const newContract = {
        ...baseContract,
        version: '2.0.0',
        functions: [
          { name: 'transfer', inputs: ['from', 'to'], outputs: ['bool'] },
          baseContract.functions[1],
        ],
      };
      const result = await validateUpgradeCompatibility(baseContract, newContract);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.compatible).toBe(false);
        expect(result.value.breakingChanges.length).toBeGreaterThan(0);
      }
    });

    it('returns error for invalid contract input', async () => {
      const result = await validateUpgradeCompatibility(null as any, baseContract);
      expect(result.ok).toBe(false);
    });
  });
});