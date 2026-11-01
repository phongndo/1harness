# nix-darwin: a LaunchAgent that keeps the server running from login.
package:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.oneharness;
in
{
  options.services.oneharness = import ./options.nix { inherit lib pkgs package; };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    launchd.user.agents.oneharness = {
      path = cfg.path ++ [
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
      ];
      serviceConfig = {
        ProgramArguments = [
          (lib.getExe cfg.package)
          "server"
          "run"
        ]
        ++ cfg.extraArgs;
        EnvironmentVariables = cfg.environment;
        KeepAlive = true;
        RunAtLoad = true;
        ProcessType = "Interactive";
        StandardOutPath = "/tmp/1harness-server.log";
        StandardErrorPath = "/tmp/1harness-server.log";
      };
    };
  };
}
