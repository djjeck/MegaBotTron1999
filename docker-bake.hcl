# MegaBotTron1999's image, for one platform or both.
#
#   docker buildx bake --load                          for this machine, tagged megabottron1999:local
#   PLATFORMS=linux/arm64 docker buildx bake --load    for arm64 (QEMU on another machine)
#   PLATFORMS=linux/amd64,linux/arm64 docker buildx bake
#                                                      both, into the build cache (--load takes one
#                                                      platform at a time)
#
# Publishing is CI's (.github/workflows/publish.yml), with docker/build-push-action.

variable "IMAGE" {
  default = "megabottron1999"
}

variable "TAGS" {
  # Comma-separated.
  default = "local"
}

variable "PLATFORMS" {
  # Comma-separated; empty for this machine's.
  default = ""
}

group "default" {
  targets = ["megabottron1999"]
}

target "megabottron1999" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = PLATFORMS == "" ? [] : split(",", PLATFORMS)
  tags       = [for t in split(",", TAGS) : "${IMAGE}:${t}"]
}
