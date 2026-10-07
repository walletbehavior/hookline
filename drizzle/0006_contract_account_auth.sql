-- EOA identity is cross-chain. A deployed smart wallet's address is not:
-- the same address can have unrelated owners on different chains.
-- Existing accounts predate EIP-1271 integration and remain EOA accounts.
ALTER TABLE accounts ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'eoa' CHECK(auth_method IN ('eoa','eip1271'));
ALTER TABLE accounts ADD COLUMN auth_chain_id INTEGER CHECK(auth_chain_id IS NULL OR auth_chain_id>0);
CREATE TRIGGER IF NOT EXISTS accounts_auth_binding_insert BEFORE INSERT ON accounts
WHEN (NEW.auth_method='eoa' AND NEW.auth_chain_id IS NOT NULL) OR (NEW.auth_method='eip1271' AND NEW.auth_chain_id IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid account authentication binding'); END;
CREATE TRIGGER IF NOT EXISTS accounts_auth_binding_update BEFORE UPDATE OF auth_method,auth_chain_id ON accounts
WHEN (NEW.auth_method='eoa' AND NEW.auth_chain_id IS NOT NULL) OR (NEW.auth_method='eip1271' AND NEW.auth_chain_id IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid account authentication binding'); END;
