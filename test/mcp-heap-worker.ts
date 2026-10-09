/** Exhausts a small worker heap, as a very large history does under the production cap. */
process.stderr.write("SECRET_WORKER_STDERR /SECRET_PATH\n");
const retained: string[][] = [];
for (;;) retained.push(Array.from({ length: 100_000 }, (_, index) => `row-${index}-${retained.length}`));
