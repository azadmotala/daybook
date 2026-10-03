# Copy to tools/release.local.ps1 and fill in. That file is git-ignored.
#
#   $SshHost    an alias from ~/.ssh/config, so no hostname or user is typed here
#   $RemoteBase the folder on the server, at least two segments deep (a document
#               root is refused: this script deletes from the target)
#   $SiteUrl    the public URL that serves $RemoteBase, ending in a slash
#
# -Preflight proves the three agree by writing a token to the folder and
# fetching it over HTTPS. Run it after changing any of them.
$SshHost    = 'my-host-alias'
$RemoteBase = 'www/daybook'
$SiteUrl    = 'https://example.com/daybook/'
