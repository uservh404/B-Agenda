# Plantilla de cambio de correo de AgendaJuventud

En Supabase, configura esta plantilla en **Authentication → Email Templates → Change Email Address**. Está preparada para confirmación mediante códigos y no contiene enlaces.

**Asunto**

```text
Confirma el cambio de correo de AgendaJuventud
```

**Cuerpo HTML**

```html
<div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6; max-width: 560px; margin: 0 auto;">
  <h2 style="color: #1d4ed8;">Confirma el cambio de correo</h2>
  <p>Recibimos una solicitud para cambiar el correo de tu cuenta de AgendaJuventud.</p>
  <p>La nueva dirección solicitada es <strong>{{ .NewEmail }}</strong>.</p>
  <p>Ingresa este código en AgendaJuventud para confirmar:</p>
  <p style="font-size: 30px; font-weight: 700; letter-spacing: 8px; color: #1d4ed8;">{{ .Token }}</p>
  <p>Por seguridad, el cambio se completará después de confirmar los códigos enviados a las direcciones involucradas.</p>
  <p>Si no solicitaste este cambio, ignora este mensaje. Tu correo actual no cambiará sin las confirmaciones requeridas.</p>
</div>
```

No agregues `{{ .ConfirmationURL }}` ni enlaces de confirmación a esta plantilla. Con **Secure email change** activado, Supabase Auth envía un código para el correo actual y otro para el nuevo; ambos se validan en AgendaJuventud.
