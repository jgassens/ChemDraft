# Official plugin toolbar groups

For each plugin, bump the manifest `apiVersion` to `^0.1.23` and set `toolbarGroup` on
every toolbar button. The host does not contain the plugin manifests, so confirm button inventories
and group choices in each plugin repository before release.

| Plugin | Known command and suggested group | Other toolbar buttons |
| --- | --- | --- |
| NMR predictor | Buttons and commands to confirm in the plugin repo; suggested `style-3d`. | To confirm in the plugin repo. |
| MolScribe OCSR | `plugin.molscribeOcsr.recognizeImage`, if contributed as a toolbar button: `select-text`. | To confirm in the plugin repo. |
| Orthonym | `plugin.orthonymNaming.insertName`, if contributed as a toolbar button: `select-text`. | To confirm in the plugin repo. |
| Assistant | Buttons and commands to confirm in the plugin repo; suggested `style-3d`. | To confirm in the plugin repo. |
| OPSIN name to structure | `plugin.opsinNameToStructure.convert`, if contributed as a toolbar button: `select-text`. | To confirm in the plugin repo. |

The host catalog identifies NMR, MolScribe, Orthonym and OPSIN; host fixtures also mention Assistant.
Known commands do not establish that a plugin actually contributes a toolbar button.
