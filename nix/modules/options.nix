# The options every 1harness module shares.
{
  lib,
  pkgs,
  package,
}:
{
  enable = lib.mkEnableOption "the 1harness server, which keeps threads working while no terminal is open";

  package = lib.mkOption {
    type = lib.types.package;
    default = package;
    defaultText = lib.literalExpression "1harness.packages.\${system}.default";
    description = "The 1harness package to run.";
  };

  path = lib.mkOption {
    type = lib.types.listOf lib.types.package;
    default = [ ];
    example = lib.literalExpression "[ pkgs.codex pkgs.claude-code ]";
    description = ''
      Packages whose programs the server finds on its PATH, such as the
      harnesses it drives. Harnesses installed outside Nix, such as with mise,
      are found through the PATH in ~/.config/1harness/server.env, which
      `1harness server install --print` shows how to write.
    '';
  };

  environment = lib.mkOption {
    type = lib.types.attrsOf lib.types.str;
    default = { };
    example = {
      ONEHARNESS_CODEX_PATH = "/home/me/.local/bin/codex";
    };
    description = "Variables the server runs with. Keep secrets out of here; they end up in the Nix store.";
  };

  extraArgs = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    example = [
      "--extra-listen"
      "tailnet://:7330"
    ];
    description = "Arguments after `1harness server run`, such as listeners for remote access.";
  };
}
