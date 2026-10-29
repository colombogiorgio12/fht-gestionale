# Gestionale FHT

Task, obiettivi, richieste e documenti del team FHT.

- `index.html`: l'app (pagina statica, pubblicata su GitHub Pages)
- `config.js`: indirizzo e chiave pubblica del progetto Supabase
- `supabase/schema.sql`: tabelle, regole di accesso e archivio file
- `supabase/functions/admin-users`: creazione account, reset password, disattivazione (solo super admin)

## Ruoli

- **Super admin**: le email elencate in `admin_emails` (schema.sql). Gestisce tutto e crea gli account.
- **Coordinatore**: crea e gestisce i task del proprio gruppo e ne approva le richieste.
- **Collaboratore**: aggiorna i propri task, commenta, registra ore, carica file, propone task e chiede proroghe.

Le regole valgono nel database, non solo nell'interfaccia. I file non si possono sovrascrivere.
Ognuno può eliminare un proprio file entro 24 ore; dopo, solo il super admin.

## Installazione

1. Crea un progetto Supabase e incolla `supabase/schema.sql` in SQL Editor → Run.
2. Crea il tuo utente in Authentication → Users → Add user, con la tua email e "Auto confirm".
3. Pubblica la funzione: `supabase functions deploy admin-users --project-ref <ref>`.
4. Inserisci URL e chiave anon in `config.js`.
