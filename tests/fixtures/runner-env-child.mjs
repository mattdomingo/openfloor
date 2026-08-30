process.stdout.write(`${process.env.OPENFLOOR_TEST_TOKEN ?? "clean"}|${process.env.PATH ? "path" : "no-path"}|${process.env.HOME ? "home" : "no-home"}`);
