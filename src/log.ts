import { Logger } from "tslog";

export const log: Logger = new Logger({
  name: "maker",
  displayFunctionName: true,
  displayLoggerName: false,
  colorizePrettyLogs: false,
  displayFilePath: "hidden",
  dateTimePattern: "year-month-dayThour:minute:second.millisecond",
  minLevel: "info",
});
