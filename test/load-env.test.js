const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadEnvFile, parseEnvValue } = require("../load-env");

const temporaryPaths = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0))
    fs.rmSync(temporaryPath, { force: true });
});

describe("loadEnvFile", () => {
  it("loads .env values without replacing explicit environment values", () => {
    const temporaryPath = path.join(
      os.tmpdir(),
      `kc-pay-env-${Date.now()}-${Math.random()}.env`,
    );
    temporaryPaths.push(temporaryPath);
    fs.writeFileSync(
      temporaryPath,
      'DB_HOST=db.example.com\nDB_PASSWORD="p@ss # word"\nPROXY=http://user:pass@example.com # note\n',
    );

    const env = { DB_HOST: "from-shell" };
    expect(loadEnvFile(temporaryPath, env)).toBe(true);
    expect(env).toEqual({
      DB_HOST: "from-shell",
      DB_PASSWORD: "p@ss # word",
      PROXY: "http://user:pass@example.com",
    });
  });

  it("keeps hash characters that are part of an unquoted value", () => {
    expect(parseEnvValue("password#suffix")).toBe("password#suffix");
  });
});
