/** Last-resort CLI boundary: source errors may contain private paths or text. */
function failSafely() {
  process.stderr.write('{"status":"failed","reason":"validation-operation-failed"}\n');
  process.exit(1);
}
process.on('uncaughtException', failSafely);
process.on('unhandledRejection', failSafely);
