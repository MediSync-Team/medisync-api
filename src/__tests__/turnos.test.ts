describe('Turnos Logic', () => {
  describe('Slot availability calculation', () => {
    it('should generate correct slots from availability', () => {
      const generateSlots = (
        horaInicio: string,
        horaFin: string,
        duracionMinutos: number = 30
      ) => {
        const slots: string[] = [];
        let [h, m] = horaInicio.split(':').map(Number);
        const [hf, mf] = horaFin.split(':').map(Number);

        while (h < hf || (h === hf && m < mf)) {
          slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
          m += duracionMinutos;
          if (m >= 60) { h++; m -= 60; }
        }
        return slots;
      };

      const slots = generateSlots('09:00', '12:00');
      expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
      expect(slots.length).toBe(6);
    });

    it('should handle different slot durations', () => {
      const generateSlots = (
        horaInicio: string,
        horaFin: string,
        duracionMinutos: number = 30
      ) => {
        const slots: string[] = [];
        let [h, m] = horaInicio.split(':').map(Number);
        const [hf, mf] = horaFin.split(':').map(Number);

        while (h < hf || (h === hf && m < mf)) {
          slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
          m += duracionMinutos;
          if (m >= 60) { h++; m -= 60; }
        }
        return slots;
      };

      expect(generateSlots('09:00', '10:00', 15).length).toBe(4);
      expect(generateSlots('09:00', '10:00', 60).length).toBe(1);
    });

    it('should calculate correct duration', () => {
      const calculateDuration = (horaInicio: string, horaFin: string) => {
        const [hi, mi] = horaInicio.split(':').map(Number);
        const [hf, mf] = horaFin.split(':').map(Number);
        return (hf * 60 + mf) - (hi * 60 + mi);
      };

      expect(calculateDuration('09:00', '12:00')).toBe(180);
      expect(calculateDuration('14:00', '14:30')).toBe(30);
      expect(calculateDuration('09:00', '09:00')).toBe(0);
    });

    it('should handle edge cases for slot generation', () => {
      const generateSlots = (
        horaInicio: string,
        horaFin: string,
        duracionMinutos: number = 30
      ) => {
        const slots: string[] = [];
        let [h, m] = horaInicio.split(':').map(Number);
        const [hf, mf] = horaFin.split(':').map(Number);

        while (h < hf || (h === hf && m < mf)) {
          slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
          m += duracionMinutos;
          if (m >= 60) { h++; m -= 60; }
        }
        return slots;
      };

      expect(generateSlots('08:00', '08:30').length).toBe(1);
      expect(generateSlots('08:00', '09:00').length).toBe(2);
      expect(generateSlots('23:00', '23:30').length).toBe(1);
    });
  });

  describe('Turno estado transitions', () => {
    const validTransitions: Record<string, string[]> = {
      RESERVADO: ['CONFIRMADO', 'CANCELADO'],
      CONFIRMADO: ['COMPLETADO', 'CANCELADO'],
      CANCELADO: [],
      COMPLETADO: [],
    };

    it('should allow valid transitions from RESERVADO', () => {
      expect(validTransitions['RESERVADO']).toContain('CONFIRMADO');
      expect(validTransitions['RESERVADO']).toContain('CANCELADO');
    });

    it('should allow valid transitions from CONFIRMADO', () => {
      expect(validTransitions['CONFIRMADO']).toContain('COMPLETADO');
      expect(validTransitions['CONFIRMADO']).toContain('CANCELADO');
    });

    it('should not allow transitions from CANCELADO', () => {
      expect(validTransitions['CANCELADO']).toHaveLength(0);
    });

    it('should not allow transitions from COMPLETADO', () => {
      expect(validTransitions['COMPLETADO']).toHaveLength(0);
    });

    it('should validate transition is allowed', () => {
      const canTransition = (from: string, to: string) => {
        return validTransitions[from]?.includes(to) ?? false;
      };

      expect(canTransition('RESERVADO', 'CONFIRMADO')).toBe(true);
      expect(canTransition('RESERVADO', 'COMPLETADO')).toBe(false);
      expect(canTransition('CANCELADO', 'RESERVADO')).toBe(false);
    });
  });

  describe('Video call link generation', () => {
    it('should generate valid Jitsi Meet links', () => {
      const generateMeetLink = () => {
        const randomId = Math.random().toString(36).substring(2, 10);
        return `https://meet.jit.si/MediSync-${randomId}`;
      };

      const link = generateMeetLink();
      expect(link).toMatch(/^https:\/\/meet\.jit\.si\/MediSync-[a-z0-9]+$/);
    });

    it('should generate unique links', () => {
      const generateMeetLink = () => {
        const randomId = Math.random().toString(36).substring(2, 10);
        return `https://meet.jit.si/MediSync-${randomId}`;
      };

      const links = new Set(Array.from({ length: 100 }, () => generateMeetLink()));
      expect(links.size).toBe(100);
    });
  });

  describe('Date filtering', () => {
    it('should filter upcoming appointments', () => {
      const now = new Date();
      const appointments = [
        { fecha: new Date(now.getTime() - 86400000), estado: 'COMPLETADO' },
        { fecha: new Date(now.getTime() + 86400000), estado: 'RESERVADO' },
        { fecha: new Date(now.getTime() + 172800000), estado: 'CONFIRMADO' },
      ];

      const upcoming = appointments.filter(a => 
        a.fecha >= now && ['RESERVADO', 'CONFIRMADO'].includes(a.estado)
      );

      expect(upcoming.length).toBe(2);
    });

    it('should filter past appointments', () => {
      const now = new Date();
      const appointments = [
        { fecha: new Date(now.getTime() - 86400000), estado: 'COMPLETADO' },
        { fecha: new Date(now.getTime() + 86400000), estado: 'RESERVADO' },
        { fecha: new Date(now.getTime() - 172800000), estado: 'CANCELADO' },
      ];

      const past = appointments.filter(a => a.fecha < now);
      expect(past.length).toBe(2);
    });

    it('should filter by modality', () => {
      const appointments = [
        { modalidad: 'VIRTUAL' },
        { modalidad: 'PRESENCIAL' },
        { modalidad: 'VIRTUAL' },
      ];

      const virtual = appointments.filter(a => a.modalidad === 'VIRTUAL');
      const presencial = appointments.filter(a => a.modalidad === 'PRESENCIAL');

      expect(virtual.length).toBe(2);
      expect(presencial.length).toBe(1);
    });
  });

  describe('Conflict detection', () => {
    it('should detect overlapping appointments', () => {
      const hasConflict = (
        existingAppointments: { fecha: Date; duracionMin: number }[],
        newFecha: Date,
        newDuracion: number = 30
      ) => {
        const newStart = newFecha.getTime();
        const newEnd = newStart + newDuracion * 60000;

        return existingAppointments.some(apt => {
          const aptStart = apt.fecha.getTime();
          const aptEnd = aptStart + apt.duracionMin * 60000;
          return newStart < aptEnd && newEnd > aptStart;
        });
      };

      const existing = [
        { fecha: new Date('2024-01-15T10:00:00'), duracionMin: 30 },
      ];

      expect(hasConflict(existing, new Date('2024-01-15T10:15:00'))).toBe(true);
      expect(hasConflict(existing, new Date('2024-01-15T10:29:00'))).toBe(true);
      expect(hasConflict(existing, new Date('2024-01-15T11:00:00'))).toBe(false);
      expect(hasConflict(existing, new Date('2024-01-15T09:30:00'))).toBe(false);
    });
  });

  describe('Day of week calculation', () => {
    it('should return correct day numbers', () => {
      const getDiaSemana = (date: Date) => date.getDay();

      const sunday = new Date('2024-01-14T12:00:00');
      const monday = new Date('2024-01-15T12:00:00');
      const friday = new Date('2024-01-19T12:00:00');
      const saturday = new Date('2024-01-20T12:00:00');

      expect(getDiaSemana(sunday)).toBe(0);
      expect(getDiaSemana(monday)).toBe(1);
      expect(getDiaSemana(friday)).toBe(5);
      expect(getDiaSemana(saturday)).toBe(6);
    });
  });

  describe('Freemium plan limits', () => {
    it('should limit FREE plan to 20 turnos per month', () => {
      const checkPlanLimit = (plan: string, turnosThisMonth: number) => {
        if (plan === 'FREE' && turnosThisMonth >= 20) {
          return 'PLAN_LIMIT_REACHED';
        }
        return 'OK';
      };

      expect(checkPlanLimit('FREE', 19)).toBe('OK');
      expect(checkPlanLimit('FREE', 20)).toBe('PLAN_LIMIT_REACHED');
      expect(checkPlanLimit('FREE', 21)).toBe('PLAN_LIMIT_REACHED');
    });

    it('should allow unlimited turnos for PRO plan', () => {
      const checkPlanLimit = (plan: string, turnosThisMonth: number) => {
        if (plan === 'FREE' && turnosThisMonth >= 20) {
          return 'PLAN_LIMIT_REACHED';
        }
        return 'OK';
      };

      expect(checkPlanLimit('PRO', 100)).toBe('OK');
      expect(checkPlanLimit('PRO', 1000)).toBe('OK');
    });

    it('should count only non-cancelled turnos', () => {
      const countValidTurnos = (turnos: { estado: string }[]) => {
        return turnos.filter(t => t.estado !== 'CANCELADO').length;
      };

      const turnos = [
        { estado: 'RESERVADO' },
        { estado: 'CONFIRMADO' },
        { estado: 'CANCELADO' },
        { estado: 'COMPLETADO' },
        { estado: 'CANCELADO' },
      ];

      expect(countValidTurnos(turnos)).toBe(3);
    });

    it('should reset count at start of new month', () => {
      const isNewMonth = (date: Date, prevDate: Date) => {
        return date.getMonth() !== prevDate.getMonth() || date.getFullYear() !== prevDate.getFullYear();
      };

      const jan15 = new Date('2024-01-15T12:00:00');
      const feb1 = new Date('2024-02-01T12:00:00');
      const feb15 = new Date('2024-02-15T12:00:00');

      expect(isNewMonth(feb1, jan15)).toBe(true);
      expect(isNewMonth(feb15, jan15)).toBe(true);
      expect(isNewMonth(jan15, jan15)).toBe(false);
    });
  });
});
