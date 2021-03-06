import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as fs from 'fs';

export type Arch = 'x86' | 'x64';
export type Variant = 'regular' | 'CS';
export type Distribution = 'minimal' | 'full';
export type Platform = 'darwin' | 'linux' | 'win32';

const RACKET_ARCHS: {[key: string]: string} = {
  'x86-darwin': 'i386',
  'x64-darwin': 'x86_64',
  'x86-linux': 'x86_64',
  'x64-linux': 'x86_64',
  'x86-win32': 'i386',
  'x64-win32': 'x86_64'
};

const RACKET_PLATFORMS: {[key: string]: string} = {
  darwin: 'macosx',
  linux: 'linux',
  win32: 'win32'
};

const RACKET_EXTS: {[key: string]: string} = {
  darwin: 'dmg',
  linux: 'sh',
  win32: 'exe'
};

export function makeInstallerURL(
  version: string,
  arch: Arch,
  distribution: Distribution,
  variant: Variant,
  platform: Platform
) {
  const racketArch = RACKET_ARCHS[`${arch}-${platform}`];
  const racketPlatform = RACKET_PLATFORMS[platform];
  const racketExt = RACKET_EXTS[platform];

  let base = `https://mirror.racket-lang.org/installers/${version}`;
  const prefix = distribution === 'minimal' ? 'racket-minimal' : 'racket';
  let maybeOS = '';
  let maybeSuffix = variant === 'CS' ? '-cs' : '';
  if (version === 'current') {
    base = 'https://www.cs.utah.edu/plt/snapshots/current/installers';
    maybeSuffix = variant === 'CS' ? '-cs' : '-bc';
    if (platform === 'linux') {
      maybeOS = variant === 'CS' ? '-xenial' : '-precise';
    }
  }

  return `${base}/${prefix}-${version}-${racketArch}-${racketPlatform}${maybeOS}${maybeSuffix}.${racketExt}`;
}

async function installDarwin(path: string) {
  await fs.promises.writeFile(
    '/tmp/install-racket.sh',
    `
sudo hdiutil attach ${path} -mountpoint /Volumes/Racket
cp -rf /Volumes/Racket/Racket* /Applications/Racket
sudo hdiutil detach /Volumes/Racket
ln -s /Applications/Racket/bin/racket /usr/local/bin/racket
ln -s /Applications/Racket/bin/raco /usr/local/bin/raco
`
  );
  await exec.exec('sh', ['/tmp/install-racket.sh']);
}

// This detects whether or not sudo is present in case we're in a
// Docker container.  See issue #2.
async function installLinux(path: string, dest: string) {
  let script;
  if (dest) {
    script = `sh ${path} --create-dir --in-place --dest ${dest}`;
  } else {
    script = `echo "yes\n1\n" | sh ${path} --create-dir --unix-style --dest /usr/`;
  }

  await fs.promises.writeFile('/tmp/install-racket.impl.sh', script);
  await fs.promises.writeFile(
    '/tmp/install-racket.sh',
    `
if command -v sudo; then
  sudo sh /tmp/install-racket.impl.sh
else
  sh /tmp/install-racket.impl.sh
fi
`
  );
  await exec.exec('sh', ['/tmp/install-racket.sh']);
}

async function installWin32(version: string, arch: Arch, path: string) {
  await fs.promises.mkdir('chocopkg');
  await fs.promises.mkdir('chocopkg/tools');
  process.chdir('chocopkg');

  await fs.promises.writeFile(
    'racket.nuspec',
    `<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2011/08/nuspec.xsd">
  <metadata>
    <id>racket</id>
    <version>${version === 'current' ? '7.999' : version}</version>
    <title>Racket</title>
    <authors>PLT Inc.</authors>
    <description>The Racket programming language.</description>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
  </metadata>
</package>
`
  );

  await fs.promises.writeFile(
    'tools/chocolateyInstall.ps1',
    `
$toolsDir   = "$(Split-Path -Parent $MyInvocation.MyCommand.Definition)"
$packageArgs = @{
        packageName = 'racket'
        silentArgs = '/S'
        fileType = 'exe'
        ${arch === 'x86' ? 'file' : 'file64'} = '${path}'
        validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
`
  );

  await exec.exec('choco pack');
  await exec.exec('choco install racket -s .');

  let programFilesPath: string;
  if (arch === 'x86') {
    programFilesPath = `C:\\Program Files (x86)`;
  } else {
    programFilesPath = `C:\\Program Files`;
  }

  let installDir = 'Racket';
  if (version === 'current') {
    for await (const name of await fs.promises.readdir(programFilesPath)) {
      if (name.indexOf('Racket') === 0) {
        installDir = name;
        break;
      }
    }
  }

  const racketPath = `${programFilesPath}\\${installDir}`;
  await fs.promises.rename(
    `${racketPath}\\Racket.exe`,
    `${racketPath}\\racket.exe`
  );
  core.addPath(racketPath);
}

export async function install(
  version: string,
  arch: Arch,
  distribution: Distribution,
  variant: Variant,
  dest: string
) {
  const path = await tc.downloadTool(
    makeInstallerURL(
      version,
      arch,
      distribution,
      variant,
      process.platform as Platform
    )
  );

  switch (process.platform as Platform) {
    case 'darwin':
      return await installDarwin(path);
    case 'linux':
      return await installLinux(path, dest);
    case 'win32':
      return await installWin32(version, arch, path);
    default:
      throw new Error(`platform '${process.platform}' is not yet supported`);
  }
}

export async function setCatalogs(catalogs: string[]) {
  await exec.exec(
    'raco',
    ['pkg', 'config', '--set', 'catalogs'].concat(catalogs)
  );
}

export async function installPackages(packages: string[]) {
  await exec.exec(
    'raco',
    ['pkg', 'install', '--auto', '--batch', '--no-docs', '--fail-fast'].concat(
      packages
    )
  );
}

export function parseArch(s: string): Arch {
  if (s !== 'x86' && s !== 'x64') {
    throw new Error(`invalid arch '${s}'`);
  }

  return s;
}

export function parseVariant(s: string): Variant {
  if (s !== 'regular' && s !== 'CS') {
    throw new Error(`invalid variant '${s}'`);
  }

  return s;
}

export function parseDistribution(s: string): Distribution {
  if (s !== 'minimal' && s !== 'full') {
    throw new Error(`invalid distribution '${s}'`);
  }

  return s;
}
