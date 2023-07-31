import { Logger } from "tslog";

require("dotenv").config({ path: __dirname + "/../.env" });
export const minLevel = process.env.LOG_LEVEL as
  | "silly"
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error";
export const log: Logger = new Logger({
  name: "maker",
  displayFunctionName: true,
  displayLoggerName: false,
  colorizePrettyLogs: false,
  displayFilePath: "hidden",
  dateTimePattern: "year-month-dayThour:minute:second.millisecond",
  minLevel,
});
