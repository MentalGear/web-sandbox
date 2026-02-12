Host SW manages updates and ensures they are valid.

The "old SW Code" checks if:
- right public key signature
- received update has a checksum that is in the "official checksum url" for the lastest verion 
- delayed update (gradual rollout): schedules the update to be applied at any x random time delay (so not all update at the same time)
- maybe internal tests: like SW can't access virtualFiles (no fetch), sandbox can't have allow-same-origin, etc. Maybe runs the whole test suite and runtime to validate update (would that actually help with security? )
- data integrity tests? maybe, but would give SW access to data.
- check if new sw code does not have means to access virtual files from the host-level. eg it should not contain fetch/virtual files, but only postmessage for communication.
- maybe sw code updates need longer cool-down phase like a week before even being applied

Host Level SW should have as little code as possible, and be as readable as possible. As it has the most privilege. (also add host CSP to never be able to connect to other domain but self and official domain for update? So even if a script reaches top, they can't connect anywhere else. but needs frame-src to be set with those srcs allowed in all open iframes.)