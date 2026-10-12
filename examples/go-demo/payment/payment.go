package payment

import "errors"

// Gateway is implemented elsewhere at runtime (a real provider, a fake in tests, ...).
type Gateway interface {
	Charge(amount float64) (string, error)
}

var ErrNothingToCharge = errors.New("nothing to charge")

func Charge(gateway Gateway, amount float64) (string, error) {
	if amount <= 0 {
		return "", ErrNothingToCharge
	}
	paymentID, err := gateway.Charge(amount)
	if err != nil {
		return "", err
	}
	return paymentID, nil
}
