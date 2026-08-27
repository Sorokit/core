export type SupportedLocale = "en" | "es";

export type MessageKey =
  | "wallet.connect.failed"
  | "wallet.device.verification_required"
  | "transaction.invalid"
  | "transaction.amount_positive"
  | "transaction.fee_unavailable"
  | "network.unavailable"
  | "escrow.invalid_state"
  | "escrow.timelock_expired"
  | (string & {});

export type TranslationCatalog = Partial<Record<MessageKey, string>>;
export type TranslationMap = Record<string, TranslationCatalog>;

export interface I18nConfig {
  locale?: string;
  translations?: TranslationMap;
}

export interface I18n {
  readonly locale: string;
  translate(key: MessageKey, variables?: Record<string, string | number>): string;
  t(key: MessageKey, variables?: Record<string, string | number>): string;
  withLocale(locale: string): I18n;
  withTranslations(translations: TranslationMap): I18n;
}

export const DEFAULT_LOCALE = "en";

export const EN_TRANSLATIONS: Required<TranslationCatalog> = {
  "wallet.connect.failed": "Unable to connect to the wallet.",
  "wallet.device.verification_required": "Additional verification is required for this device.",
  "transaction.invalid": "The transaction is invalid.",
  "transaction.amount_positive": "The amount must be positive.",
  "transaction.fee_unavailable": "A transaction fee estimate is unavailable.",
  "network.unavailable": "The network is currently unavailable.",
  "escrow.invalid_state": "The escrow cannot perform this action in its current state.",
  "escrow.timelock_expired": "The escrow timelock has expired.",
};

export const ES_TRANSLATIONS: Required<TranslationCatalog> = {
  "wallet.connect.failed": "No se puede conectar con la billetera.",
  "wallet.device.verification_required": "Se requiere verificación adicional para este dispositivo.",
  "transaction.invalid": "La transacción no es válida.",
  "transaction.amount_positive": "El importe debe ser positivo.",
  "transaction.fee_unavailable": "No hay una estimación de comisión disponible.",
  "network.unavailable": "La red no está disponible actualmente.",
  "escrow.invalid_state": "El depósito no puede realizar esta acción en su estado actual.",
  "escrow.timelock_expired": "El bloqueo temporal del depósito ha expirado.",
};

const BUILTIN_TRANSLATIONS: TranslationMap = { en: EN_TRANSLATIONS, es: ES_TRANSLATIONS };

function interpolate(value: string, variables?: Record<string, string | number>): string {
  if (!variables) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
  );
}

function normalizeLocale(locale?: string): string {
  return (locale || DEFAULT_LOCALE).trim().toLowerCase().replace(/_/g, "-").split("-")[0] || DEFAULT_LOCALE;
}

export function createI18n(config: I18nConfig = {}): I18n {
  const locale = normalizeLocale(config.locale);
  const custom = config.translations ?? {};
  const translate = (key: MessageKey, variables?: Record<string, string | number>): string => {
    const value = custom[locale]?.[key] ?? BUILTIN_TRANSLATIONS[locale]?.[key] ?? custom[DEFAULT_LOCALE]?.[key] ?? EN_TRANSLATIONS[key];
    return interpolate(value ?? String(key), variables);
  };
  return {
    locale,
    translate,
    t: translate,
    withLocale: (nextLocale) => createI18n({
      locale: nextLocale,
      ...(Object.keys(custom).length > 0 ? { translations: custom } : {}),
    }),
    withTranslations: (translations) => createI18n({
      locale,
      translations: { ...custom, ...translations },
    }),
  };
}

export function translateMessage(
  key: MessageKey,
  locale?: string,
  translations?: TranslationMap,
  variables?: Record<string, string | number>,
): string {
  return createI18n({
    ...(locale !== undefined ? { locale } : {}),
    ...(translations !== undefined ? { translations } : {}),
  }).translate(key, variables);
}

export interface LocalizedError {
  code: string;
  message: string;
  cause?: unknown;
}

/** Localize presentation text without ever changing the machine-readable code. */
export function localizeError(
  error: LocalizedError,
  i18n: I18n,
  messageKey?: MessageKey,
  variables?: Record<string, string | number>,
): LocalizedError {
  return { ...error, message: messageKey ? i18n.translate(messageKey, variables) : error.message };
}
