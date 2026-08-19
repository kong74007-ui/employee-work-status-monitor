const { createPackage } = require("@electron/asar");
const { downloadArtifact } = require("@electron/get");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yauzl = require("yauzl");
const yazl = require("yazl");

const productName = "员工状态上报";
const appId = "com.local.employee-status-client";
const projectDir = path.resolve(__dirname, "..");
const outputDir = path.resolve(projectDir, "..", "employee-installers");
const electronVersion = require(path.join(projectDir, "node_modules", "electron", "package.json")).version;

const appFiles = [
  "main.js",
  "preload.js",
  "renderer.js",
  "index.html",
  "styles.css",
  "employee.config.example.json",
  "package.json",
];

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const appAsar = await createAppAsar();
  const config = fs.readFileSync(path.join(projectDir, "employee.config.example.json"));

  for (const arch of ["arm64", "x64"]) {
    const zipPath = await downloadArtifact({
      version: electronVersion,
      artifactName: "electron",
      platform: "darwin",
      arch,
    });
    const target = path.join(outputDir, `${productName}-mac-${arch}-测试版.zip`);
    await rewriteElectronZip(zipPath, target, appAsar, config);
    console.log(target);
  }
}

async function createAppAsar() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "employee-app-"));
  const appRoot = path.join(tempRoot, "app");
  fs.mkdirSync(appRoot, { recursive: true });

  for (const file of appFiles) {
    fs.copyFileSync(path.join(projectDir, file), path.join(appRoot, file));
  }
  fs.cpSync(path.join(projectDir, "assets"), path.join(appRoot, "assets"), { recursive: true });

  const packageJsonPath = path.join(appRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  delete packageJson.devDependencies;
  delete packageJson.build;
  packageJson.name = "employee-status-client";
  packageJson.productName = productName;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const asarPath = path.join(tempRoot, "app.asar");
  await createPackage(appRoot, asarPath);
  return fs.readFileSync(asarPath);
}

function rewriteElectronZip(sourceZip, targetZip, appAsar, config) {
  return new Promise((resolve, reject) => {
    yauzl.open(sourceZip, { lazyEntries: true }, (openError, source) => {
      if (openError) return reject(openError);

      const target = new yazl.ZipFile();
      const output = fs.createWriteStream(targetZip);
      let sourceEnded = false;
      let pendingStreams = 0;

      const finishIfReady = () => {
        if (!sourceEnded || pendingStreams > 0) return;
        const resourceRoot = `${productName}.app/Contents/Resources`;
        target.addBuffer(appAsar, `${resourceRoot}/app.asar`, {
          mode: 0o100644,
          mtime: new Date(),
        });
        target.addBuffer(config, `${resourceRoot}/employee.config.json`, {
          mode: 0o100644,
          mtime: new Date(),
        });
        target.end();
      };

      target.outputStream.pipe(output);
      output.on("close", resolve);
      output.on("error", reject);
      target.outputStream.on("error", reject);

      source.readEntry();
      source.on("entry", (entry) => {
        const mappedName = mapEntryName(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) || fallbackMode(entry.fileName);
        const options = {
          mtime: entry.getLastModDate(),
          mode,
        };

        if (/\/$/.test(entry.fileName)) {
          target.addEmptyDirectory(mappedName, options);
          source.readEntry();
          return;
        }

        pendingStreams += 1;
        source.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            pendingStreams -= 1;
            return reject(streamError);
          }

          if (entry.fileName === "Electron.app/Contents/Info.plist") {
            streamToBuffer(stream)
              .then((buffer) => {
                target.addBuffer(rewriteInfoPlist(buffer), mappedName, options);
                pendingStreams -= 1;
                source.readEntry();
                finishIfReady();
              })
              .catch(reject);
            return;
          }

          target.addReadStream(stream, mappedName, options);
          stream.on("end", () => {
            pendingStreams -= 1;
            source.readEntry();
            finishIfReady();
          });
          stream.on("error", reject);
        });
      });

      source.on("end", () => {
        sourceEnded = true;
        finishIfReady();
      });
      source.on("error", reject);
    });
  });
}

function mapEntryName(name) {
  return name.replace(/^Electron\.app\//, `${productName}.app/`);
}

function rewriteInfoPlist(buffer) {
  return Buffer.from(
    buffer
      .toString("utf8")
      .replace(/com\.github\.Electron/g, appId)
      .replace(/>Electron</g, `>${productName}<`)
      .replace(/Electron\.app/g, `${productName}.app`),
  );
}

function fallbackMode(name) {
  return /\/$/.test(name) ? 0o40755 : 0o100644;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
