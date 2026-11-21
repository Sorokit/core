import { describe, it, expect } from "vitest";
import {
  validateAddress,
  isValidAddress,
  validateAmount,
  validateAssetCode,
  validateUrl,
  sanitizeInput,
  validateContractMethodSpec,
  isValidContractMethodSpec,
  validateSorobanType,
  STELLAR_MAX_DECIMALS,
  STELLAR_MAX_AMOUNT,
  SOROBAN_MAX_METHOD_NAME_LEN,
} from "../utility/validator";
import { SorokitErrorCode, SorokitErrorCategory } from "../shared/response";

describe("Validator Framework", () => {
  // Known valid addresses
  const VALID_G_ADDR = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const VALID_G_ADDR_2 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const VALID_C_ADDR = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
  const VALID_M_ADDR = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";

  describe("validateAddress", () => {
    it("accepts valid Ed25519 G-address", () => {
      const res = validateAddress(VALID_G_ADDR);
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.address).toBe(VALID_G_ADDR);
        expect(res.data.value).toBe(VALID_G_ADDR);
        expect(res.data.type).toBe("ed25519_public_key");
      }
    });

    it("accepts valid Soroban C-contract address", () => {
      const res = validateAddress(VALID_C_ADDR);
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.address).toBe(VALID_C_ADDR);
        expect(res.data.type).toBe("contract");
      }
    });

    it("accepts valid Muxed M-address", () => {
      const res = validateAddress(VALID_M_ADDR);
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.address).toBe(VALID_M_ADDR);
        expect(res.data.type).toBe("muxed_account");
      }
    });

    it("handles leading and trailing whitespace", () => {
      const res = validateAddress(`  ${VALID_G_ADDR}  `);
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.address).toBe(VALID_G_ADDR);
      }
    });

    it("rejects non-string and empty inputs", () => {
      expect(validateAddress("").status).toBe("error");
      expect(validateAddress("   ").status).toBe("error");
      expect(validateAddress(null).status).toBe("error");
      expect(validateAddress(undefined).status).toBe("error");
      expect(validateAddress(12345).status).toBe("error");
      expect(validateAddress({}).status).toBe("error");
    });

    it("rejects Stellar secret seed (S-prefix)", () => {
      const secret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
      const res = validateAddress(secret);
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
        expect(res.error.category).toBe(SorokitErrorCategory.VALIDATION);
      }
    });

    it("rejects malformed G-addresses with invalid checksum or length", () => {
      const badChecksum = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMAD0";
      const tooShort = "GBZXN7PIRZGNMH";
      expect(validateAddress(badChecksum).status).toBe("error");
      expect(validateAddress(tooShort).status).toBe("error");
    });

    it("rejects arbitrary strings", () => {
      const res = validateAddress("invalid-stellar-address");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
      }
    });

    it("isValidAddress helper returns boolean", () => {
      expect(isValidAddress(VALID_G_ADDR)).toBe(true);
      expect(isValidAddress(VALID_C_ADDR)).toBe(true);
      expect(isValidAddress(VALID_M_ADDR)).toBe(true);
      expect(isValidAddress("invalid")).toBe(false);
      expect(isValidAddress(null)).toBe(false);
    });
  });

  describe("validateAmount", () => {
    it("accepts valid positive amounts", () => {
      const res1 = validateAmount("100");
      expect(res1.status).toBe("ok");
      if (res1.status === "ok") {
        expect(res1.data.amount).toBe("100");
        expect(res1.data.decimals).toBe(0);
      }

      const res2 = validateAmount("10.5");
      expect(res2.status).toBe("ok");
      if (res2.status === "ok") {
        expect(res2.data.amount).toBe("10.5");
        expect(res2.data.decimals).toBe(1);
      }

      const res3 = validateAmount(250.75);
      expect(res3.status).toBe("ok");
      if (res3.status === "ok") {
        expect(res3.data.amount).toBe("250.75");
        expect(res3.data.decimals).toBe(2);
      }

      const res4 = validateAmount("0.0000001");
      expect(res4.status).toBe("ok");
      if (res4.status === "ok") {
        expect(res4.data.decimals).toBe(STELLAR_MAX_DECIMALS);
      }
    });

    it("attaches asset information when provided", () => {
      const res = validateAmount("50", "USDC");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.asset).toBe("USDC");
      }
    });

    it("rejects invalid asset code passed to validateAmount", () => {
      const res = validateAmount("50", "INVALID_ASSET_CODE_TOO_LONG");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });

    it("rejects zero by default, but allows it when allowZero: true", () => {
      expect(validateAmount("0").status).toBe("error");
      expect(validateAmount("0.0").status).toBe("error");

      const allowed = validateAmount("0", undefined, { allowZero: true });
      expect(allowed.status).toBe("ok");
    });

    it("rejects negative amounts", () => {
      expect(validateAmount("-5").status).toBe("error");
      expect(validateAmount(-10.2).status).toBe("error");
    });

    it("rejects non-numeric and scientific notation inputs", () => {
      expect(validateAmount("abc").status).toBe("error");
      expect(validateAmount("1e5").status).toBe("error");
      expect(validateAmount("10.5.5").status).toBe("error");
      expect(validateAmount(NaN).status).toBe("error");
      expect(validateAmount(Infinity).status).toBe("error");
      expect(validateAmount(null).status).toBe("error");
      expect(validateAmount("").status).toBe("error");
    });

    it("rejects amounts exceeding decimal precision", () => {
      // 8 decimals exceeds default 7
      const res = validateAmount("0.00000001");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
      }

      // custom maxDecimals
      const resCustom = validateAmount("10.123", undefined, { maxDecimals: 2 });
      expect(resCustom.status).toBe("error");
    });

    it("rejects amounts exceeding maximum supply bounds", () => {
      const maxOk = validateAmount(STELLAR_MAX_AMOUNT);
      expect(maxOk.status).toBe("ok");

      const overMax = validateAmount("922337203685.4775808");
      expect(overMax.status).toBe("error");

      const wayOverMax = validateAmount("99999999999999999999");
      expect(wayOverMax.status).toBe("error");
    });
  });

  describe("validateAssetCode", () => {
    it("accepts valid alphanumeric asset codes (1 to 12 chars)", () => {
      expect(validateAssetCode("A").status).toBe("ok");
      expect(validateAssetCode("USDC").status).toBe("ok");
      expect(validateAssetCode("MYTOKEN12").status).toBe("ok");
      expect(validateAssetCode("123456789012").status).toBe("ok");
    });

    it("accepts 'native' case-insensitively", () => {
      const res = validateAssetCode("native");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.code).toBe("native");
      }

      const resUpper = validateAssetCode("NATIVE");
      expect(resUpper.status).toBe("ok");
    });

    it("rejects empty codes or codes exceeding 12 characters", () => {
      expect(validateAssetCode("").status).toBe("error");
      expect(validateAssetCode("   ").status).toBe("error");
      expect(validateAssetCode("ABCDEFGHIJKLM").status).toBe("error"); // 13 chars
    });

    it("rejects non-alphanumeric characters", () => {
      expect(validateAssetCode("USDC-").status).toBe("error");
      expect(validateAssetCode("USD_C").status).toBe("error");
      expect(validateAssetCode("USD$").status).toBe("error");
      expect(validateAssetCode("US DC").status).toBe("error");
    });

    it("rejects non-string inputs", () => {
      expect(validateAssetCode(null).status).toBe("error");
      expect(validateAssetCode(undefined).status).toBe("error");
      expect(validateAssetCode(123).status).toBe("error");
    });
  });

  describe("validateUrl", () => {
    it("accepts valid HTTP and HTTPS URLs", () => {
      const res = validateUrl("https://horizon.stellar.org/accounts");
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.protocol).toBe("https:");
        expect(res.data.hostname).toBe("horizon.stellar.org");
        expect(res.data.pathname).toBe("/accounts");
      }

      expect(validateUrl("http://localhost:8000").status).toBe("ok");
    });

    it("rejects dangerous or disallowed protocols", () => {
      expect(validateUrl("javascript:alert(1)").status).toBe("error");
      expect(validateUrl("data:text/html,<script>alert(1)</script>").status).toBe("error");
      expect(validateUrl("file:///etc/passwd").status).toBe("error");
      expect(validateUrl("ftp://ftp.example.com").status).toBe("error");
    });

    it("rejects URLs with embedded credentials to prevent phishing", () => {
      const res = validateUrl("https://admin:secret@malicious.com");
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
      }
    });

    it("supports requireTld option", () => {
      expect(validateUrl("http://internal", { requireTld: true }).status).toBe("error");
      expect(validateUrl("http://internal.org", { requireTld: true }).status).toBe("ok");
    });

    it("rejects malformed URLs and non-string inputs", () => {
      expect(validateUrl("not a url").status).toBe("error");
      expect(validateUrl("").status).toBe("error");
      expect(validateUrl(null).status).toBe("error");
    });
  });

  describe("sanitizeInput", () => {
    it("strips script tags and inner script content", () => {
      const malicious = '<script>alert("XSS")</script>Hello World';
      expect(sanitizeInput(malicious)).toBe("Hello World");
    });

    it("strips iframe, embed, object, and style tags", () => {
      const input = '<iframe src="evil.com"></iframe><style>body{color:red}</style>Safe Content';
      expect(sanitizeInput(input)).toBe("Safe Content");
    });

    it("strips inline javascript event handlers", () => {
      const input = '<img src="x" onerror="alert(1)">Image';
      expect(sanitizeInput(input)).toBe("Image");
    });

    it("strips javascript and vbscript pseudoprotocols", () => {
      const input = 'javascript:doSomething()';
      expect(sanitizeInput(input)).toBe("doSomething()");
    });

    it("strips standard HTML tags when stripHtml is true", () => {
      const input = '<p>This is <b>bold</b> and <i>italic</i>.</p>';
      expect(sanitizeInput(input)).toBe("This is bold and italic.");
    });

    it("removes non-printable ASCII control characters", () => {
      const input = "clean\x00text\x07with\x1Fcontrol";
      expect(sanitizeInput(input)).toBe("cleantextwithcontrol");
    });

    it("trims whitespace by default", () => {
      expect(sanitizeInput("   stellar lumens   ")).toBe("stellar lumens");
    });

    it("enforces maxLength when option provided", () => {
      expect(sanitizeInput("1234567890", { maxLength: 5 })).toBe("12345");
    });

    it("handles null, undefined, and non-strings safely", () => {
      expect(sanitizeInput(null)).toBe("");
      expect(sanitizeInput(undefined)).toBe("");
      expect(sanitizeInput(12345)).toBe("12345");
    });
  });

  describe("validateContractMethodSpec (#769)", () => {
    describe("method name validation", () => {
      it("accepts valid alphanumeric and snake_case method names", () => {
        const validNames = ["transfer", "balance", "allowance", "increase_allowance", "_internal", "mint123", "CamelCase"];
        for (const name of validNames) {
          const res = validateContractMethodSpec({ name, inputs: [], returnType: "void" });
          expect(res.status).toBe("ok");
          if (res.status === "ok") {
            expect(res.data.name).toBe(name);
          }
        }
      });

      it("rejects method names starting with a digit (e.g. 123_invalid)", () => {
        const res = validateContractMethodSpec({ name: "123_invalid" });
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.code).toBe(SorokitErrorCode.VALIDATION);
          expect(res.error.message).toContain("starts with a digit");
          expect(res.error.message).toContain("Soroban method specification");
        }
      });

      it("rejects method names with hyphens, spaces, or symbols", () => {
        const invalidNames = ["foo-bar", "transfer token", "deposit.asset", "bad@method", "test#1", " transfer "];
        for (const name of invalidNames) {
          const res = validateContractMethodSpec({ name });
          expect(res.status).toBe("error");
          if (res.status === "error") {
            expect(res.error.message).toContain("invalid characters");
            expect(res.error.message).toContain("CAP-0046");
          }
        }
      });

      it("rejects reserved keywords in Soroban and Rust", () => {
        const keywords = ["fn", "let", "mut", "impl", "struct", "match", "return", "__constructor"];
        for (const name of keywords) {
          const res = validateContractMethodSpec({ name });
          expect(res.status).toBe("error");
          if (res.status === "error") {
            expect(res.error.message).toContain("reserved keyword");
            expect(res.error.message).toContain("Soroban specification");
          }
        }
      });

      it("rejects method names exceeding 32 characters", () => {
        const longName = "a".repeat(SOROBAN_MAX_METHOD_NAME_LEN + 1);
        const res = validateContractMethodSpec({ name: longName });
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.message).toContain("exceeds the maximum Soroban symbol limit of 32 characters");
        }
      });

      it("rejects empty or non-string method names", () => {
        expect(validateContractMethodSpec({ name: "" }).status).toBe("error");
        expect(validateContractMethodSpec({ name: "   " }).status).toBe("error");
        expect(validateContractMethodSpec({ name: 123 }).status).toBe("error");
        expect(validateContractMethodSpec({ name: null }).status).toBe("error");
      });
    });

    describe("parameter and type validation", () => {
      it("accepts valid Soroban scalar types", () => {
        const scalars = [
          "u32", "i32", "u64", "i64", "u128", "i128", "u256", "i256",
          "bool", "void", "string", "symbol", "bytes", "bytes32", "address",
        ];
        for (const type of scalars) {
          const res = validateContractMethodSpec({
            name: "test_method",
            inputs: [{ name: "param1", type }],
            returnType: "void",
          });
          expect(res.status).toBe("ok");
        }
      });

      it("accepts valid container types with generics", () => {
        const containers = [
          "vec<u32>",
          "vec<string>",
          "map<string, i128>",
          "option<address>",
          "result<u32, error>",
          "tuple<u32, bool>",
        ];
        for (const type of containers) {
          const res = validateContractMethodSpec({
            name: "test_container",
            inputs: [{ name: "data", type }],
          });
          expect(res.status).toBe("ok");
        }
      });

      it("accepts nested container types", () => {
        const nested = [
          "vec<vec<u32>>",
          "map<string, vec<i64>>",
          "option<vec<address>>",
        ];
        for (const type of nested) {
          const res = validateContractMethodSpec({
            name: "test_nested",
            inputs: [{ name: "nested_data", type }],
          });
          expect(res.status).toBe("ok");
        }
      });

      it("rejects invalid scalar types (e.g. invalid_scval_type, int, float)", () => {
        const invalidTypes = ["invalid_scval_type", "int", "float", "decimal", "uint", "boolean"];
        for (const type of invalidTypes) {
          const res = validateContractMethodSpec({
            name: "transfer",
            inputs: [{ name: "amount", type }],
          });
          expect(res.status).toBe("error");
          if (res.status === "error") {
            expect(res.error.message).toContain("Invalid Soroban type");
            expect(res.error.message).toContain("ScSpecTypeDef");
          }
        }
      });

      it("rejects container types with incorrect arity", () => {
        // option requires 1 param
        expect(validateContractMethodSpec({
          name: "op_test",
          inputs: [{ name: "x", type: "option<u32, i64>" }],
        }).status).toBe("error");

        // map requires 2 params
        expect(validateContractMethodSpec({
          name: "map_test",
          inputs: [{ name: "m", type: "map<string>" }],
        }).status).toBe("error");

        // vec requires 1 param
        expect(validateContractMethodSpec({
          name: "vec_test",
          inputs: [{ name: "v", type: "vec<u32, i64>" }],
        }).status).toBe("error");

        for (const type of ["vec", "map", "option", "result"]) {
          expect(validateContractMethodSpec({
            name: "bare_container",
            inputs: [{ name: "value", type }],
          }).status).toBe("error");
        }
      });

      it("rejects scalar types with generic arguments", () => {
        const res = validateContractMethodSpec({
          name: "bad_scalar",
          inputs: [{ name: "x", type: "u32<string>" }],
        });
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.message).toContain("Scalar type \"u32\" cannot have generic type parameters");
        }
      });

      it("rejects malformed generic brackets", () => {
        expect(validateContractMethodSpec({
          name: "unclosed",
          inputs: [{ name: "x", type: "vec<u32" }],
        }).status).toBe("error");

        expect(validateContractMethodSpec({
          name: "empty_inner",
          inputs: [{ name: "x", type: "vec<>" }],
        }).status).toBe("error");
      });

      it("rejects invalid parameter names", () => {
        const res = validateContractMethodSpec({
          name: "transfer",
          inputs: [{ name: "123_invalid_param", type: "u32" }],
        });
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.message).toContain("Parameter name \"123_invalid_param\"");
        }
      });

      it("rejects non-array inputs", () => {
        const res = validateContractMethodSpec({
          name: "transfer",
          inputs: "u32" as any,
        });
        expect(res.status).toBe("error");
      });
    });

    describe("return type validation", () => {
      it("accepts void, unit, or omitted return types", () => {
        const voidVariants = [undefined, null, "void", "()", "unit"];
        for (const ret of voidVariants) {
          const res = validateContractMethodSpec({
            name: "execute",
            returnType: ret,
          });
          expect(res.status).toBe("ok");
          if (res.status === "ok") {
            expect(res.data.returnType).toBeNull();
          }
        }
      });

      it("accepts valid non-void return types", () => {
        const res = validateContractMethodSpec({
          name: "get_balance",
          returnType: "i128",
        });
        expect(res.status).toBe("ok");
        if (res.status === "ok") {
          expect(res.data.returnType).toBe("i128");
        }
      });

      it("rejects invalid return type", () => {
        const res = validateContractMethodSpec({
          name: "bad_return",
          returnType: "invalid_scval_type",
        });
        expect(res.status).toBe("error");
        if (res.status === "error") {
          expect(res.error.message).toContain("Invalid Soroban type \"invalid_scval_type\"");
          expect(res.error.message).toContain("returnType");
        }
      });

      it("rejects malformed return type descriptors", () => {
        for (const returnType of [123, {}, { type: 123 }, ""]) {
          expect(validateContractMethodSpec({ name: "malformed_return", returnType }).status).toBe("error");
        }
      });
    });

    describe("flexible input shapes & helpers", () => {
      it("supports parameters / params / args aliases", () => {
        const resParams = validateContractMethodSpec({
          name: "test_params",
          params: [{ name: "x", type: "u32" }],
        });
        expect(resParams.status).toBe("ok");

        const resArgs = validateContractMethodSpec({
          name: "test_args",
          args: ["i64", "address"],
        });
        expect(resArgs.status).toBe("ok");
        if (resArgs.status === "ok") {
          expect(resArgs.data.inputs).toHaveLength(2);
          expect(resArgs.data.inputs[0].name).toBe("arg0");
          expect(resArgs.data.inputs[0].type).toBe("i64");
          expect(resArgs.data.inputs[1].name).toBe("arg1");
          expect(resArgs.data.inputs[1].type).toBe("address");
        }
      });

      it("supports returns / return_type aliases", () => {
        const res1 = validateContractMethodSpec({
          name: "check",
          returns: "bool",
        });
        expect(res1.status).toBe("ok");
        if (res1.status === "ok") expect(res1.data.returnType).toBe("bool");

        const res2 = validateContractMethodSpec({
          name: "check2",
          return_type: "u64",
        });
        expect(res2.status).toBe("ok");
        if (res2.status === "ok") expect(res2.data.returnType).toBe("u64");
      });

      it("rejects non-object method specs", () => {
        expect(validateContractMethodSpec(null).status).toBe("error");
        expect(validateContractMethodSpec(undefined).status).toBe("error");
        expect(validateContractMethodSpec("string").status).toBe("error");
        expect(validateContractMethodSpec([]).status).toBe("error");
      });

      it("isValidContractMethodSpec helper returns boolean", () => {
        expect(isValidContractMethodSpec({ name: "valid_method", inputs: ["u32"] })).toBe(true);
        expect(isValidContractMethodSpec({ name: "123_invalid" })).toBe(false);
      });
    });
  });
});
