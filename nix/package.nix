{
  lib,
  stdenv,
  nodejs_24,
  pnpm,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  autoPatchelfHook,
  # html2term draws images and pages for terminals; without it, PNGs show as
  # they are and pages as their text.
  html2term ? null,
}:

let
  manifest = lib.importJSON ../package.json;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "1harness";
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../.npmrc
      ../tsconfig.json
      ../src
    ];
  };

  # Node 24 runs the TypeScript sources as they are, so only runtime
  # dependencies are installed.
  pnpmInstallFlags = [ "--prod" ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmInstallFlags
      ;
    fetcherVersion = 4;
    hash = "sha256-HKpmC/EUY59CAX5PGXeJXE+Ge6vouIjZZkDWVyak1gw=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  # Native modules, such as fff's file search, link against these.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/1harness $out/bin
    cp -r package.json src node_modules $out/lib/1harness/
    rm -rf $out/lib/1harness/src/testing
    find $out/lib/1harness/src -name '*.test.ts' -delete
    makeWrapper ${lib.getExe nodejs_24} $out/bin/1harness \
      --add-flags $out/lib/1harness/src/cli.ts${
        lib.optionalString (html2term != null)
          " --set-default HTML2TERM_BIN ${lib.getExe html2term}"
      }
    ln -s 1harness $out/bin/1h
    runHook postInstall
  '';

  meta = {
    description = manifest.description;
    homepage = "https://github.com/phongndo/1harness";
    mainProgram = "1harness";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
