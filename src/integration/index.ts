/**
 * SEP Integration Module
 *
 * Exports all SEP (Stellar Ecosystem Proposal) integration functions for
 * cross-border payments, deposits/withdrawals, KYC, and interactive flows.
 */

// ─── SEP-31 Direct Payments ─────────────────────────────────────────────────────
export {
  quoteDirectPayment,
  sendDirectPayment,
  trackDirectPayment,
  validateReceiver,
} from "./sep31DirectPayment";
export type {
  DirectPaymentQuoteRequest,
  DirectPaymentQuoteResponse,
  DirectPaymentRequest,
  DirectPaymentResponse,
  DirectPaymentStatusResponse,
} from "./sep31DirectPayment";

// ─── SEP-6 Deposit and Withdrawal ───────────────────────────────────────────────
export {
  getAssetInfo,
  initiateDeposit,
  initiateWithdraw,
  trackTransaction,
  getTransactions,
} from "./sep6Flow";
export type {
  AssetInfo,
  DepositRequest,
  DepositResponse,
  WithdrawalRequest,
  WithdrawalResponse,
  TransactionInfo,
} from "./sep6Flow";

// ─── SEP-12 Customer Info Collection and KYC ───────────────────────────────────
export {
  getKycFields,
  submitKycInfo,
  getKycStatus,
  deleteKycInfo,
  uploadKycDocument,
} from "./sep12Kyc";
export type {
  KycField,
  KycFieldsResponse,
  KycInfo,
  KycSubmissionResponse,
  KycStatusResponse,
} from "./sep12Kyc";

// ─── SEP-24 Interactive Deposit and Withdrawal ───────────────────────────────
export {
  getInteractiveAssetInfo,
  initiateInteractiveDeposit,
  initiateInteractiveWithdraw,
  monitorTransaction,
  getInteractiveTransactions,
  openInteractivePopup,
  pollTransactionStatus,
} from "./sep24Flow";
export type {
  InteractiveAssetInfo,
  InteractiveDepositRequest,
  InteractiveDepositResponse,
  InteractiveWithdrawalRequest,
  InteractiveWithdrawalResponse,
  InteractiveTransactionInfo,
  InteractiveFlowConfig,
} from "./sep24Flow";
