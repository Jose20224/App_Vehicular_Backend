-- Prueba SQL de aceptación B6. Ejecutar en una base de pruebas luego de B6
-- y de seed de test. El script hace ROLLBACK y no deja filas de verificación.
BEGIN;
DO $$
DECLARE
  v_user_id UUID;
  v_service_type_id UUID;
  v_active_workshop_id UUID;
  v_provider_id UUID := '00000000-0000-7000-8000-000000009904';
BEGIN
  SELECT user_id, id INTO v_user_id, v_active_workshop_id
  FROM public.workshops WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1;
  SELECT id INTO v_service_type_id FROM public.service_types WHERE is_active ORDER BY sort_order LIMIT 1;

  IF v_user_id IS NULL OR v_service_type_id IS NULL OR v_active_workshop_id IS NULL THEN
    RAISE EXCEPTION 'B6 XOR test requires a user, an active service type and an active seeded workshop.';
  END IF;

  -- Un dueño exacto: debe aceptarse.
  INSERT INTO public.service_offerings (
    id, user_id, workshop_id, assistance_provider_id, service_type_id,
    name, price_min, price_max, currency, unit
  ) VALUES (
    '00000000-0000-7000-8000-000000009900', v_user_id, v_active_workshop_id, NULL, v_service_type_id,
    'XOR test dueño taller válido', 1, 2, 'USD', 'por servicio'
  );

  -- Cero dueños: debe fallar por chk_service_offerings_exactly_one_owner.
  BEGIN
    INSERT INTO public.service_offerings (
      id, user_id, workshop_id, assistance_provider_id, service_type_id,
      name, price_min, price_max, currency, unit
    ) VALUES (
      '00000000-0000-7000-8000-000000009901', v_user_id, NULL, NULL, v_service_type_id,
      'XOR test cero dueños', 1, 2, 'USD', 'por servicio'
    );
    RAISE EXCEPTION 'Expected check_violation for ServiceOffering without an owner.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Para que la prueba de dos dueños aísle el CHECK (y no falle por una FK),
  -- el dueño de prueba pasa temporalmente a admin, rol permitido para ambos tipos.
  UPDATE public.users SET role = 'admin' WHERE id = v_user_id;
  INSERT INTO public.assistance_providers (
    id, user_id, name, provider_type, service_type_id
  ) VALUES (
    v_provider_id, v_user_id, 'Proveedor XOR sintético', 'test', v_service_type_id
  );

  -- Un dueño exacto de tipo proveedor: también debe aceptarse.
  INSERT INTO public.service_offerings (
    id, user_id, workshop_id, assistance_provider_id, service_type_id,
    name, price_min, price_max, currency, unit
  ) VALUES (
    '00000000-0000-7000-8000-000000009903', v_user_id, NULL, v_provider_id, v_service_type_id,
    'XOR test dueño proveedor válido', 1, 2, 'USD', 'por servicio'
  );

  -- Dos dueños válidos: debe fallar específicamente por el mismo CHECK.
  BEGIN
    INSERT INTO public.service_offerings (
      id, user_id, workshop_id, assistance_provider_id, service_type_id,
      name, price_min, price_max, currency, unit
    ) VALUES (
      '00000000-0000-7000-8000-000000009902', v_user_id,
      v_active_workshop_id, v_provider_id,
      v_service_type_id, 'XOR test dos dueños', 1, 2, 'USD', 'por servicio'
    );
    RAISE EXCEPTION 'Expected check_violation for ServiceOffering with two owners.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La restricción de activación debe impedir retirar la referencia local.
  BEGIN
    UPDATE public.workshops
    SET address_reference_text = NULL
    WHERE id = v_active_workshop_id;
    RAISE EXCEPTION 'Expected check_violation when an active workshop loses its local reference.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;
ROLLBACK;
