#!/usr/bin/env node
import { Command } from "commander";
import { registerAccountCommand } from "./commands/account.js";
import { registerTxCommand } from "./commands/tx.js";
import { registerFundCommand } from "./commands/fund.js";
import { registerPayCommand } from "./commands/pay.js";
import { registerContractCommand } from "./commands/contract.js";
import { registerConfigCommand } from "./commands/config.js";

const program = new Command();

program
  .name("sorokit")
  .description("Command-line tool for common sorokit-core / Stellar operations")
  .version("0.1.0");

registerAccountCommand(program);
registerTxCommand(program);
registerFundCommand(program);
registerPayCommand(program);
registerContractCommand(program);
registerConfigCommand(program);

program.parseAsync(process.argv);
