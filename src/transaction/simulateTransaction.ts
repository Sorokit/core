/**
 * NOTE: Transaction pre-flight simulation uses the Soroban RPC server
 * and therefore lives in src/soroban/simulateTransaction.ts.
 *
 * This file is intentionally empty — simulation is not a transaction
 * module concern. Access it via client.soroban.simulate().
 *
 * The client wires soroban.simulate() without this module importing
 * anything from soroban/.
 */
