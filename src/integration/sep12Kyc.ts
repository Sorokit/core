/**
 * SEP-12 Customer Info Collection and KYC
 *
 * Implements SEP-12 for collecting and managing customer KYC information.
 * Handles field retrieval, info submission, and status tracking.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface KycField {
  /** Field name/ID */
  name: string;
  /** Field type */
  type: "string" | "number" | "date" | "boolean" | "select" | "binary" | "string_array";
  /** Whether the field is required */
  required: boolean;
  /** Field description */
  description?: string;
  /** Optional choices for select type */
  choices?: string[];
  /** Example value */
  example?: string;
  /** Additional validation rules */
  [key: string]: unknown;
}

export interface KycFieldsResponse {
  /** KYC fields for the customer */
  fields: KycField[];
  /** Accepted countries (ISO 3166-1 alpha-2) */
  countries?: string[];
  /** Required documents */
  documents?: {
    /** Document type */
    type: string;
    /** Whether the document is required */
    required: boolean;
    /** Description */
    description?: string;
  }[];
}

export interface KycInfo {
  /** Customer's Stellar public key */
  account: string;
  /** Customer's email */
  email?: string;
  /** Customer's first name */
  firstName?: string;
  /** Customer's last name */
  lastName?: string;
  /** Customer's date of birth (ISO 8601) */
  dateOfBirth?: string;
  /** Customer's country (ISO 3166-1 alpha-2) */
  country?: string;
  /** Customer's address */
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  /** Customer's phone number */
  phoneNumber?: string;
  /** Customer's tax ID */
  taxId?: string;
  /** Additional fields as required by the anchor */
  [key: string]: unknown;
}

export interface KycSubmissionResponse {
  /** Submission ID for tracking */
  id: string;
  /** Status of the submission */
  status: "pending" | "processing" | "approved" | "rejected";
  /** When the submission was created (ISO 8601 timestamp) */
  createdAt: string;
  /** Additional information from the anchor */
  [key: string]: unknown;
}

export interface KycStatusResponse {
  /** Customer's Stellar public key */
  account: string;
  /** KYC status */
  status: "pending" | "processing" | "approved" | "rejected";
  /** When the status was last updated (ISO 8601 timestamp) */
  updatedAt: string;
  /** Reason for rejection (if applicable) */
  rejectionReason?: string;
  /** Additional information from the anchor */
  [key: string]: unknown;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Get the required KYC fields for a customer from an anchor.
 *
 * @param serverUrl - The SEP-12 anchor server URL
 * @param account - The Stellar public key of the customer
 * @returns SorokitResult with KYC fields
 */
export async function getKycFields(
  serverUrl: string,
  account: string,
): Promise<SorokitResult<KycFieldsResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getKycFields: serverUrl must be a non-empty string.",
      );
    }

    if (!account || typeof account !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getKycFields: account must be a non-empty string.",
      );
    }

    const url = new URL("/sep12/customer", serverUrl);
    url.searchParams.append("account", account);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-12 fields request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as KycFieldsResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getKycFields: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Submit KYC information for a customer to an anchor.
 *
 * @param serverUrl - The SEP-12 anchor server URL
 * @param account - The Stellar public key of the customer
 * @param info - The KYC information to submit
 * @returns SorokitResult with submission response
 */
export async function submitKycInfo(
  serverUrl: string,
  account: string,
  info: KycInfo,
): Promise<SorokitResult<KycSubmissionResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "submitKycInfo: serverUrl must be a non-empty string.",
      );
    }

    if (!account || typeof account !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "submitKycInfo: account must be a non-empty string.",
      );
    }

    if (!info || typeof info !== "object") {
      return err(
        SorokitErrorCode.VALIDATION,
        "submitKycInfo: info must be a non-empty object.",
      );
    }

    const url = new URL("/sep12/customer", serverUrl);
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...info,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-12 submission failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as KycSubmissionResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `submitKycInfo: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Get the KYC status for a customer from an anchor.
 *
 * @param serverUrl - The SEP-12 anchor server URL
 * @param account - The Stellar public key of the customer
 * @returns SorokitResult with KYC status
 */
export async function getKycStatus(
  serverUrl: string,
  account: string,
): Promise<SorokitResult<KycStatusResponse>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getKycStatus: serverUrl must be a non-empty string.",
      );
    }

    if (!account || typeof account !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "getKycStatus: account must be a non-empty string.",
      );
    }

    const url = new URL("/sep12/customer", serverUrl);
    url.searchParams.append("account", account);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-12 status request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as KycStatusResponse);
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `getKycStatus: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Delete KYC information for a customer from an anchor.
 *
 * @param serverUrl - The SEP-12 anchor server URL
 * @param account - The Stellar public key of the customer
 * @returns SorokitResult indicating success
 */
export async function deleteKycInfo(
  serverUrl: string,
  account: string,
): Promise<SorokitResult<{ success: boolean }>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "deleteKycInfo: serverUrl must be a non-empty string.",
      );
    }

    if (!account || typeof account !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "deleteKycInfo: account must be a non-empty string.",
      );
    }

    const url = new URL("/sep12/customer", serverUrl);
    url.searchParams.append("account", account);
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-12 deletion failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    return ok({ success: true });
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `deleteKycInfo: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}

/**
 * Upload a document for KYC verification.
 *
 * @param serverUrl - The SEP-12 anchor server URL
 * @param account - The Stellar public key of the customer
 * @param documentType - The type of document (e.g., "passport", "id_card")
 * @param file - The file to upload (File object or base64 string)
 * @returns SorokitResult with upload response
 */
export async function uploadKycDocument(
  serverUrl: string,
  account: string,
  documentType: string,
  file: File | string,
): Promise<SorokitResult<{ id: string; status: string }>> {
  try {
    if (!serverUrl || typeof serverUrl !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "uploadKycDocument: serverUrl must be a non-empty string.",
      );
    }

    if (!account || typeof account !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "uploadKycDocument: account must be a non-empty string.",
      );
    }

    if (!documentType || typeof documentType !== "string") {
      return err(
        SorokitErrorCode.VALIDATION,
        "uploadKycDocument: documentType must be a non-empty string.",
      );
    }

    const url = new URL("/sep12/customer/documents", serverUrl);
    const formData = new FormData();
    formData.append("account", account);
    formData.append("type", documentType);

    if (typeof file === "string") {
      // Assume base64 string
      formData.append("file", file);
    } else {
      // File object
      formData.append("file", file);
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `SEP-12 document upload failed: ${response.status} ${response.statusText}`,
        errorText,
      );
    }

    const data = await response.json();
    return ok(data as { id: string; status: string });
  } catch (error) {
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `uploadKycDocument: ${error instanceof Error ? error.message : "Unknown error"}`,
      error,
    );
  }
}
