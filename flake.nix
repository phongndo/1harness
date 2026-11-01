{
  description = "1harness: one terminal UI for agent harnesses, with a server that keeps threads working";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
      packageFor = system: self.packages.${system}.default;
    in
    {
      packages = forEachSystem (system: {
        default = nixpkgs.legacyPackages.${system}.callPackage ./nix/package.nix { };
      });

      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe (packageFor system);
        };
      });

      # services.oneharness for NixOS, nix-darwin, and home-manager.
      nixosModules.default =
        { pkgs, ... }:
        {
          imports = [ (import ./nix/modules/nixos.nix (packageFor pkgs.stdenv.hostPlatform.system)) ];
        };
      darwinModules.default =
        { pkgs, ... }:
        {
          imports = [ (import ./nix/modules/darwin.nix (packageFor pkgs.stdenv.hostPlatform.system)) ];
        };
      homeManagerModules.default =
        { pkgs, ... }:
        {
          imports = [
            (import ./nix/modules/home-manager.nix (packageFor pkgs.stdenv.hostPlatform.system))
          ];
        };

      devShells = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.git
            ];
          };
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
