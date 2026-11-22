/**
 * Real Docker integration test for run_code. Skips (exit 0) when Docker is not
 * available locally; CI runs it on ubuntu-latest, which ships Docker.
 *
 * Run with: npm run test:sandbox   (set REQUIRE_DOCKER=1 to fail instead of skip)
 */
import { dockerAvailable, runCode } from "../src/sandbox.js";

if (!(await dockerAvailable())) {
  if (process.env.REQUIRE_DOCKER === "1") {
    console.error("FAIL  Docker is required but not available");
    process.exit(1);
  }
  console.log("SKIP  Docker not available — sandbox integration tests skipped");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, condition, detail) => {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
};

const SUM = {
  cpp: "#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<\"\\n\";}",
  c: "#include <stdio.h>\nint main(){long long a,b;scanf(\"%lld %lld\",&a,&b);printf(\"%lld\\n\",a+b);return 0;}",
  python: "a, b = map(int, input().split())\nprint(a + b)",
  java: "import java.util.*;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextLong()+s.nextLong());}}",
  go: "package main\nimport \"fmt\"\nfunc main(){var a,b int64;fmt.Scan(&a,&b);fmt.Println(a+b)}",
  rust: "use std::io::*;\nfn main(){let mut s=String::new();stdin().read_to_string(&mut s).unwrap();let v:Vec<i64>=s.split_whitespace().map(|x|x.parse().unwrap()).collect();println!(\"{}\",v[0]+v[1]);}",
};

for (const [language, code] of Object.entries(SUM)) {
  const r = await runCode(language, code, "40 2\n");
  check(`${language}: compiles and runs (reads stdin)`, r.success && r.stdout === "42", r);
  check(`${language}: reports a run time`, typeof r.execution_time === "number" && r.execution_time >= 0, r);
}

const ce = await runCode("cpp", "int main( { return 0; }");
check("compile error is reported, not run", !ce.success && ce.compile_error.includes("error"), ce);

const tle = await runCode("python", "while True:\n    pass", "", {
  limits: { memory: "256m", cpus: 1, pids: 64, compileTimeout: 20, executionTimeout: 2 },
});
check("infinite loop is stopped as a time limit", tle.timed_out && !tle.success, tle);

const re = await runCode("python", "import sys\nsys.exit(3)");
check("non-zero exit code is surfaced", re.exit_code === 3 && !re.success, re);

const net = await runCode(
  "python",
  "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 80), timeout=3)\n    print('ONLINE')\nexcept OSError:\n    print('OFFLINE')",
);
check("network access is blocked", net.stdout === "OFFLINE", net);

const ro = await runCode("python", "try:\n    open('/etc/pwned','w')\n    print('WROTE')\nexcept OSError:\n    print('READONLY')");
check("root filesystem is read-only", ro.stdout === "READONLY", ro);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
