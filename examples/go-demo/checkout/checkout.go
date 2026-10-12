package checkout

import (
	"errors"
	"fmt"

	"example.com/checkoutdemo/payment"
	"example.com/checkoutdemo/pricing"
	"example.com/checkoutdemo/types"
)

var ErrEmptyCart = errors.New("cart is empty")

func ProcessCheckout(cart types.Cart, gateway payment.Gateway) (types.Receipt, error) {
	if err := validateCart(cart); err != nil {
		return types.Receipt{}, err
	}
	total := pricing.CalculateTotal(cart.Items)
	discount := pricing.ApplyDiscount(total, cart.Customer)
	defer recordAudit(cart.Customer.ID)

	paymentID, err := payment.Charge(gateway, total-discount)
	if err != nil {
		return types.Receipt{}, fmt.Errorf("checkout failed: %w", err)
	}
	receipt := types.Receipt{PaymentID: paymentID, Total: total, Discount: discount}
	go sendReceipt(receipt)
	return receipt, nil
}

func validateCart(cart types.Cart) error {
	if len(cart.Items) == 0 {
		return ErrEmptyCart
	}
	return nil
}

func recordAudit(customerID string) {
	fmt.Println("checkout finished for", customerID)
}

func sendReceipt(receipt types.Receipt) {
	fmt.Println("receipt sent:", receipt.PaymentID)
}
